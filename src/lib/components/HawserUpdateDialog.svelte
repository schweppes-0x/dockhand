<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import { CircleArrowUp, CheckCircle2, XCircle, Loader2, Circle, Ship, AlertCircle, ExternalLink, Undo2 } from 'lucide-svelte';
	import { checkHawserUpdate, launchedHawserUpdates, markHawserUpdateLaunched, type HawserUpdateCheck } from '$lib/stores/hawser-updates';

	interface Props {
		open: boolean;
		environmentId: number;
		environmentName: string;
		onupdated?: () => void;
	}

	let { open = $bindable(), environmentId, environmentName, onupdated }: Props = $props();

	/** How long the agent may stay away before the update is reported as failed. */
	const RECONNECT_TIMEOUT_MS = 5 * 60 * 1000;
	const POLL_INTERVAL_MS = 2000;

	type Phase = 'checking' | 'unavailable' | 'confirm' | 'preparing' | 'updating' | 'completed' | 'rolled_back' | 'error';
	let phase = $state<Phase>('checking');
	let check = $state<HawserUpdateCheck | null>(null);
	let errorMessage = $state<string | null>(null);
	let finalVersion = $state<string | null>(null);
	let agentOffline = $state(false);
	/** The updater was already collected elsewhere, so only the resulting version is known. */
	let resultUnknown = $state(false);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	interface StepState {
		id: string;
		label: string;
		status: 'pending' | 'active' | 'completed' | 'error';
		logs: string[];
	}

	const ALL_STEPS = [
		{ id: 'pulling_image', label: 'Pulling new image' },
		{ id: 'building_config', label: 'Building container config' },
		{ id: 'pulling_updater', label: 'Pulling updater' },
		{ id: 'creating_container', label: 'Creating new container' },
		{ id: 'launching_updater', label: 'Launching updater' },
		{ id: 'replacing', label: 'Replacing the agent container' }
	] as const;

	const freshSteps = (): StepState[] => ALL_STEPS.map((s) => ({ id: s.id, label: s.label, status: 'pending', logs: [] }));
	let steps = $state<StepState[]>(freshSteps());

	$effect(() => {
		if (open) untrack(() => begin());
		else stopPolling();
	});

	async function begin() {
		errorMessage = null;
		finalVersion = null;
		agentOffline = false;
		resultUnknown = false;
		steps = freshSteps();

		const launched = launchedHawserUpdates.get(environmentId);
		if (launched) {
			resumeUpdating();
			return;
		}

		phase = 'checking';
		check = await checkHawserUpdate(environmentId);
		if (check.inFlight) {
			markHawserUpdateLaunched(environmentId, check.inFlight.updaterId);
			resumeUpdating();
		} else if (check.supported && check.updateAvailable) {
			phase = 'confirm';
		} else {
			phase = 'unavailable';
		}
	}

	function resumeUpdating() {
		for (const s of steps) if (s.id !== 'replacing') s.status = 'completed';
		setStep('replacing', 'active');
		phase = 'updating';
		poll();
	}

	function stopPolling() {
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	}

	function setStep(id: string, status: StepState['status']) {
		const step = steps.find((s) => s.id === id);
		if (step) step.status = status;
	}

	function addLog(message: string) {
		const step = steps.find((s) => s.status === 'active');
		if (step) step.logs.push(message);
	}

	async function startUpdate() {
		phase = 'preparing';
		errorMessage = null;
		steps = freshSteps();

		try {
			const response = await fetch(`/api/environments/${environmentId}/hawser-update`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' }
			});
			if ((response.headers.get('content-type') || '').includes('application/json')) {
				const data = await response.json();
				fail(data.error || 'Update failed');
				return;
			}
			if (!response.body) {
				fail('No response body');
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let eventType = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (line.startsWith('event: ')) eventType = line.substring(7).trim();
					else if (line.startsWith('data: ')) handleEvent(eventType, JSON.parse(line.substring(6)));
				}
			}
			if (phase === 'preparing') fail('The update stream ended unexpectedly');
		} catch (err) {
			if (phase === 'preparing') fail('Connection lost: ' + String(err));
		}
	}

	function handleEvent(event: string, data: any) {
		if (event === 'step') {
			setStep(data.step, data.status === 'completed' ? 'completed' : 'active');
		} else if (event === 'log') {
			addLog(data.message);
		} else if (event === 'launched') {
			markHawserUpdateLaunched(environmentId, data.updaterId);
			resumeUpdating();
		} else if (event === 'error') {
			fail(data.message || 'Update failed');
		}
	}

	function fail(message: string) {
		const active = steps.find((s) => s.status === 'active');
		if (active) active.status = 'error';
		errorMessage = message;
		phase = 'error';
	}

	async function poll() {
		stopPolling();
		const launched = launchedHawserUpdates.get(environmentId);
		if (!open || !launched || phase !== 'updating') return;

		try {
			const res = await fetch(
				`/api/environments/${environmentId}/hawser-update/progress?updaterId=${encodeURIComponent(launched.updaterId)}`,
				{ signal: AbortSignal.timeout(10000) }
			);
			if (res.ok) {
				const data = await res.json();
				agentOffline = !data.agentConnected;
				if (data.outcome && data.outcome !== 'running') {
					finish(data);
					return;
				}
			}
		} catch {
			// Dockhand or the agent is briefly unreachable during the swap; keep polling
		}

		if (Date.now() - launched.startedAt > RECONNECT_TIMEOUT_MS) {
			launchedHawserUpdates.delete(environmentId);
			fail(
				`The agent did not come back within ${RECONNECT_TIMEOUT_MS / 60000} minutes. On the host, check the updater with ` +
					`"docker logs ${launched.updaterId.substring(0, 12)}" and the agent containers with "docker ps -a".`
			);
			return;
		}
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	}

	function finish(data: { outcome: string; logs?: string; version?: string; exitCode?: number }) {
		launchedHawserUpdates.delete(environmentId);
		const step = steps.find((s) => s.id === 'replacing')!;
		if (data.logs) step.logs = data.logs.split('\n').filter((l) => l.trim());
		finalVersion = data.version || null;

		switch (data.outcome) {
			case 'updated':
			case 'unknown':
				step.status = 'completed';
				resultUnknown = data.outcome === 'unknown';
				phase = 'completed';
				break;
			case 'rolled_back':
				step.status = 'error';
				phase = 'rolled_back';
				break;
			case 'rollback_failed':
				fail('The new agent failed and restoring the previous container failed too. Manual intervention is required on the host; see the updater log above.');
				break;
			default:
				fail(`The updater failed (exit code ${data.exitCode ?? 'unknown'}) before replacing the agent. See the updater log above.`);
		}
		checkHawserUpdate(environmentId);
		onupdated?.();
	}

	function close() {
		if (phase === 'preparing') return;
		stopPolling();
		open = false;
	}

	function getIconComponent(status: string) {
		switch (status) {
			case 'completed': return CheckCircle2;
			case 'active': return Loader2;
			case 'error': return XCircle;
			default: return Circle;
		}
	}

	function getIconClass(status: string): string {
		switch (status) {
			case 'completed': return 'text-green-600 dark:text-green-400';
			case 'active': return 'text-blue-600 dark:text-blue-400 animate-spin';
			case 'error': return 'text-red-600 dark:text-red-400';
			default: return 'text-muted-foreground/30';
		}
	}

	const visibleSteps = $derived(steps.filter((s) => s.status !== 'pending'));
	const completedCount = $derived(steps.filter((s) => s.status === 'completed').length);
	const progressPercentage = $derived(Math.round((completedCount / ALL_STEPS.length) * 100));
	const inProgressView = $derived(phase === 'preparing' || phase === 'updating' || phase === 'completed' || phase === 'rolled_back' || phase === 'error');
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) close(); }}>
	<Dialog.Content class="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col" onInteractOutside={(e) => { if (phase === 'preparing') e.preventDefault(); }}>
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				<CircleArrowUp class="w-5 h-5 text-amber-500" />
				{phase === 'confirm' || phase === 'checking' || phase === 'unavailable' ? 'Update Hawser' : 'Updating Hawser'}
				<span class="text-muted-foreground font-normal">· {environmentName}</span>
			</Dialog.Title>
			{#if phase === 'updating'}
				<Dialog.Description>
					{agentOffline ? 'The agent is offline while its container is replaced...' : 'Waiting for the updater on the host...'}
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		{#if phase === 'checking'}
			<div class="flex items-center gap-2 text-sm text-muted-foreground py-6">
				<Loader2 class="w-4 h-4 animate-spin" />
				Checking the agent...
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={close}>Cancel</Button>
			</Dialog.Footer>

		{:else if phase === 'unavailable' && check}
			<div class="space-y-3 py-2 text-sm">
				{#if check.supported}
					<p class="flex items-center gap-2">
						<CheckCircle2 class="w-4 h-4 text-green-600 dark:text-green-400" />
						Hawser {check.currentVersion ?? ''} is up to date.
					</p>
					{#if check.reason}
						<p class="text-muted-foreground">{check.reason}</p>
					{/if}
				{:else}
					<p class="text-muted-foreground">{check.reason || check.error || 'Updating this agent from Dockhand is not possible.'}</p>
					{#if check.candidates?.length}
						<p class="text-muted-foreground">Hawser containers found: <span class="font-mono">{check.candidates.join(', ')}</span></p>
					{/if}
					<a href="https://github.com/Finsys/hawser#quick-start" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline inline-flex items-center gap-1 text-xs">
						<ExternalLink class="w-3 h-3" />
						Manual update instructions
					</a>
				{/if}
				{#if check.newerIncompatibleVersion}
					<p class="text-xs text-muted-foreground">
						Hawser {check.newerIncompatibleVersion} is available but is a new major version, so it is not applied automatically. Update the image tag on the host to move to it.
					</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={close}>Close</Button>
			</Dialog.Footer>

		{:else if phase === 'confirm' && check}
			<div class="space-y-4 py-2 overflow-y-auto min-h-0 flex-1">
				<div class="space-y-2">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Container</span>
						<span class="font-medium flex items-center gap-1.5">
							<Ship class="w-3.5 h-3.5" />
							{check.containerName}
						</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Current</span>
						<span class="flex items-center gap-2">
							{#if check.currentVersion}<span class="text-xs">{check.currentVersion}</span>{/if}
							<Badge variant="secondary" class="font-mono text-xs">{check.currentImage}</Badge>
						</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">New</span>
						<span class="flex items-center gap-2">
							{#if check.targetVersion}
								<a href="https://github.com/Finsys/hawser/releases/tag/v{check.targetVersion}" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline text-xs inline-flex items-center gap-1">
									{check.targetVersion}
									<ExternalLink class="w-3 h-3" />
								</a>
							{:else}
								<span class="text-xs text-muted-foreground">newer image for the same tag</span>
							{/if}
							<Badge variant="default" class="font-mono text-xs">{check.targetImage}</Badge>
						</span>
					</div>
				</div>

				<div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5 text-xs text-muted-foreground">
					<p>
						The agent goes offline for up to a minute while an updater container on the host swaps it for the new one.
						Open terminals, log streams and running operations on this environment will be interrupted.
					</p>
					<p>If the new agent doesn't come back, the updater restores the current container automatically.</p>
				</div>

				{#if check.newerIncompatibleVersion}
					<p class="text-xs text-muted-foreground">
						Hawser {check.newerIncompatibleVersion} is also available but is a new major version, so it is not applied here.
					</p>
				{/if}

				{#if check.isComposeManaged}
					<div class="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
						<p class="text-xs text-muted-foreground">
							<span class="font-medium text-blue-400">Note:</span> This agent is managed by Docker Compose. The next
							<code class="text-2xs">docker compose up</code> on the host applies whatever tag the compose file specifies.
						</p>
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={close}>Cancel</Button>
				<Button onclick={startUpdate}>
					<CircleArrowUp class="w-4 h-4 mr-2" />
					Update now
				</Button>
			</Dialog.Footer>

		{:else if inProgressView}
			<div class="flex-1 min-h-0 space-y-4 py-4 overflow-hidden flex flex-col">
				<div class="space-y-2 shrink-0">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Progress</span>
						<Badge variant="secondary">{completedCount}/{ALL_STEPS.length}</Badge>
					</div>
					<Progress value={progressPercentage} class="h-2" />
				</div>

				{#if visibleSteps.length > 0}
					<div class="border rounded-lg divide-y flex-1 min-h-0 overflow-auto">
						{#each visibleSteps as step (step.id)}
							{@const StepIcon = getIconComponent(step.status)}
							<div class="text-sm">
								<div class="flex items-center gap-3 p-3">
									<StepIcon class="w-4 h-4 shrink-0 {getIconClass(step.status)}" />
									<div class="flex-1 min-w-0 font-medium">{step.label}</div>
								</div>
								{#if step.logs.length > 0}
									<div class="bg-muted/50 px-3 py-2 font-mono text-xs border-t overflow-x-hidden max-h-64 overflow-y-auto">
										{#each step.logs as line}
											<div class="text-muted-foreground break-all">{line}</div>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if phase === 'completed'}
					<div class="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg shrink-0">
						<CheckCircle2 class="w-4 h-4 shrink-0" />
						{#if resultUnknown}
							The update finished{finalVersion ? ` and the agent now runs Hawser ${finalVersion}` : ''}.
						{:else}
							{finalVersion ? `Hawser updated to ${finalVersion}.` : 'Hawser updated.'}
						{/if}
					</div>
				{:else if phase === 'rolled_back'}
					<div class="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg shrink-0">
						<Undo2 class="w-4 h-4 shrink-0 mt-0.5" />
						<span>
							The new agent didn't come up, so the previous container was restored{finalVersion ? ` (Hawser ${finalVersion})` : ''}.
							The updater log above shows why.
						</span>
					</div>
				{:else if phase === 'error' && errorMessage}
					<div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-950/30 rounded-lg overflow-hidden shrink-0">
						<AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
						<span class="break-words">{errorMessage}</span>
					</div>
				{/if}
			</div>

			<Dialog.Footer class="shrink-0">
				{#if phase === 'preparing'}
					<Button variant="outline" disabled>
						<Loader2 class="w-4 h-4 mr-2 animate-spin" />
						Preparing...
					</Button>
				{:else if phase === 'updating'}
					<Button variant="outline" onclick={close}>Close (keeps running)</Button>
				{:else}
					<Button variant="outline" onclick={close}>Close</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
