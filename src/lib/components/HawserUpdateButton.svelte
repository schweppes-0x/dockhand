<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { CircleArrowUp, Loader2, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-svelte';
	import HawserUpdateDialog from '$lib/components/HawserUpdateDialog.svelte';
	import { hawserUpdateChecks, checkHawserUpdate } from '$lib/stores/hawser-updates';

	interface Props {
		environmentId: number;
		environmentName: string;
		/** Button/link only, for tight spots like container details. */
		compact?: boolean;
		onupdated?: () => void;
	}

	let { environmentId, environmentName, compact = false, onupdated }: Props = $props();

	let dialogOpen = $state(false);
	let checking = $state(false);
	const check = $derived($hawserUpdateChecks[environmentId]);
	const inProgress = $derived(!!check?.inFlight?.running);

	async function refresh() {
		checking = true;
		await checkHawserUpdate(environmentId);
		checking = false;
	}

	onMount(() => {
		if (!$hawserUpdateChecks[environmentId]) refresh();
	});
</script>

{#if checking && !check}
	<p class="text-xs text-muted-foreground flex items-center gap-1.5">
		<Loader2 class="w-3 h-3 animate-spin" />
		Checking for Hawser updates...
	</p>
{:else if check}
	{#if inProgress}
		<Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => (dialogOpen = true)}>
			<Loader2 class="w-3 h-3 mr-1 animate-spin" />
			Hawser update in progress
		</Button>
	{:else if check.updateAvailable}
		<div class="flex items-center gap-2 {compact ? '' : 'justify-between'}">
			{#if !compact}
				<p class="text-xs">
					<span class="text-muted-foreground">Hawser update:</span>
					{check.currentVersion ?? check.currentImage} → {check.targetVersion ?? 'newer image'}
				</p>
			{/if}
			<Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => (dialogOpen = true)}>
				<CircleArrowUp class="w-3 h-3 mr-1 text-amber-500" />
				Update Hawser
			</Button>
		</div>
	{:else if check.supported}
		{#if !compact}
			<p class="text-xs text-muted-foreground flex items-center gap-1.5">
				<CheckCircle2 class="w-3 h-3 text-green-600 dark:text-green-400" />
				Hawser {check.currentVersion ?? ''} is up to date
				<button type="button" class="text-primary hover:underline inline-flex items-center gap-1 ml-1" onclick={refresh} disabled={checking}>
					<RefreshCw class="w-3 h-3 {checking ? 'animate-spin' : ''}" />
					Check again
				</button>
			</p>
		{/if}
	{:else}
		<div class="text-xs text-muted-foreground space-y-1">
			{#if !compact}
				<p>{check.reason || check.error || 'Hawser cannot be updated from Dockhand.'}</p>
			{/if}
			<a href="https://github.com/Finsys/hawser#quick-start" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline inline-flex items-center gap-1">
				<ExternalLink class="w-3 h-3" />
				Update instructions on GitHub
			</a>
		</div>
	{/if}
{/if}

<HawserUpdateDialog bind:open={dialogOpen} {environmentId} {environmentName} {onupdated} />
