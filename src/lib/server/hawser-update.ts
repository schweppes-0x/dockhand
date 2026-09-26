/**
 * Update a Docker-deployed Hawser agent from Dockhand.
 *
 * Everything runs on the remote daemon through the agent itself: pull the new
 * image, pre-create the replacement container, then start the updater sidecar
 * (ROLLBACK=1) which swaps the containers while the agent is offline. The sidecar
 * is left behind after it exits so its logs and exit code can be read once an
 * agent — new, or the old one after a rollback — is reachable again.
 */
import { getEnvironment } from './db';
import { dockerFetch, pullImage, inspectContainer, inspectImage, checkImageUpdateAvailable, getHawserInfo } from './docker';
import { getEdgeConnectionInfo, isEdgeConnected } from './hawser';
import { demuxDockerStream } from './docker-demux-core';
import {
	selectHawserContainer,
	parseHawserImage,
	pickCompatibleRelease,
	findSocketMount,
	updaterOutcome,
	type ContainerSummary,
	type HawserUpdateOutcome
} from './hawser-update-core';
import { launchHawserUpdate, listUpdaters, remoteJson, isHawserUpdater, UPDATER_LABEL, type LaunchDeps } from './hawser-update-launch';

const RELEASES_URL = 'https://api.github.com/repos/Finsys/hawser/releases?per_page=50';
const RELEASES_TTL_MS = 10 * 60 * 1000;

export interface HawserUpdateCheck {
	supported: boolean;
	reason?: string;
	candidates?: string[];
	currentVersion?: string;
	currentImage?: string;
	containerName?: string;
	targetImage?: string;
	targetVersion?: string;
	updateAvailable: boolean;
	newerIncompatibleVersion?: string;
	isComposeManaged?: boolean;
	inFlight?: { updaterId: string; running: boolean; fromVersion?: string; targetImage?: string };
}

export interface HawserUpdateProgress {
	agentConnected: boolean;
	outcome?: HawserUpdateOutcome | 'unknown';
	exitCode?: number;
	logs?: string;
	version?: string;
	fromVersion?: string;
	targetImage?: string;
}

/** Environments with an update between "started" and "updater launched". */
const preparing = new Set<number>();

let releasesCache: { at: number; tags: string[] } | null = null;

async function fetchHawserReleaseTags(): Promise<string[]> {
	if (releasesCache && Date.now() - releasesCache.at < RELEASES_TTL_MS) return releasesCache.tags;
	const res = await fetch(RELEASES_URL, {
		headers: { Accept: 'application/vnd.github+json' },
		signal: AbortSignal.timeout(5000)
	});
	if (!res.ok) throw new Error(`GitHub releases returned ${res.status}`);
	const releases = (await res.json()) as Array<{ tag_name: string; draft?: boolean; prerelease?: boolean }>;
	const tags = releases.filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name);
	releasesCache = { at: Date.now(), tags };
	return tags;
}

async function agentReachable(env: { id: number; connectionType?: string | null }): Promise<boolean> {
	if (env.connectionType === 'hawser-edge') return isEdgeConnected(env.id);
	return (await getHawserInfo(env.id)) !== null;
}

async function agentVersion(env: { id: number; connectionType?: string | null }): Promise<string | undefined> {
	if (env.connectionType === 'hawser-edge') return getEdgeConnectionInfo(env.id)?.agentVersion;
	return (await getHawserInfo(env.id))?.hawserVersion;
}

function remoteDeps(envId: number): LaunchDeps {
	return {
		request: (path, init) => dockerFetch(path, init, envId),
		pullImage: (image, onProgress) => pullImage(image, onProgress, envId),
		inspectContainer: (id) => inspectContainer(id, envId),
		inspectImage: (image) => inspectImage(image, envId)
	};
}

async function loadEnv(envId: number) {
	const env = await getEnvironment(envId);
	if (!env) throw new Error('Environment not found');
	if (env.connectionType !== 'hawser-standard' && env.connectionType !== 'hawser-edge') {
		return { env, unsupported: 'This environment is not connected through Hawser.' };
	}
	return { env, unsupported: undefined };
}

/** Locate the agent container and work out the version it should move to. */
export async function checkHawserUpdate(envId: number): Promise<HawserUpdateCheck> {
	const { env, unsupported } = await loadEnv(envId);
	if (unsupported) return { supported: false, updateAvailable: false, reason: unsupported };
	if (!(await agentReachable(env))) {
		return { supported: false, updateAvailable: false, reason: 'The Hawser agent is not connected.' };
	}

	const currentVersion = (await agentVersion(env)) || env.hawserVersion || undefined;

	// A running updater is an update in progress; an exited one still holds the
	// result of an update nobody collected yet (the dialog was closed).
	const updaters = await listUpdaters(remoteDeps(envId));
	const pending = updaters.find((c) => c.State === 'running') ?? updaters[0];
	const inFlight = pending && {
		updaterId: pending.Id,
		running: pending.State === 'running',
		fromVersion: pending.Labels?.[`${UPDATER_LABEL}.from`],
		targetImage: pending.Labels?.[`${UPDATER_LABEL}.target`]
	};
	if (inFlight?.running) return { supported: true, updateAvailable: false, currentVersion, inFlight };

	const result = await resolveUpdateTarget(env, currentVersion);
	return inFlight ? { ...result, inFlight } : result;
}

async function resolveUpdateTarget(
	env: { id: number; connectionType?: string | null; port?: number | null },
	currentVersion: string | undefined
): Promise<HawserUpdateCheck> {
	const envId = env.id;
	const containers = await remoteJson<ContainerSummary[]>(remoteDeps(envId), '/containers/json');
	const selected = selectHawserContainer(containers, {
		edgeHostname: env.connectionType === 'hawser-edge' ? getEdgeConnectionInfo(envId)?.hostname : undefined,
		port: env.connectionType === 'hawser-standard' ? env.port ?? undefined : undefined
	});
	if (!selected.ok) {
		return { supported: false, updateAvailable: false, currentVersion, reason: selected.reason, candidates: selected.candidates };
	}

	const inspect = await inspectContainer(selected.id, envId);
	const socket = findSocketMount(inspect);
	const currentImage: string = inspect.Config?.Image || '';
	const base = {
		currentVersion,
		currentImage,
		containerName: selected.name,
		isComposeManaged: !!inspect.Config?.Labels?.['com.docker.compose.project']
	};
	if (!socket.ok) return { ...base, supported: false, updateAvailable: false, reason: socket.reason };

	const image = parseHawserImage(currentImage);
	if (image.kind === 'digest') {
		return { ...base, supported: true, updateAvailable: false, reason: 'The Hawser image is pinned by digest.' };
	}

	if (image.kind === 'floating') {
		// Image (the running image id) is in Docker's inspect response but not in ContainerInspectResult
		const imageId = (inspect as unknown as { Image: string }).Image;
		const result = await checkImageUpdateAvailable(currentImage, imageId, envId);
		if (result.error) return { ...base, supported: true, updateAvailable: false, reason: result.error };
		return { ...base, supported: true, updateAvailable: result.hasUpdate, targetImage: currentImage };
	}

	const { target, newerIncompatible } = pickCompatibleRelease(image.version, await fetchHawserReleaseTags());
	return {
		...base,
		supported: true,
		updateAvailable: target !== null,
		targetVersion: target ?? undefined,
		targetImage: target ? `${image.repo}:${image.prefix}${target}${image.suffix}` : undefined,
		newerIncompatibleVersion: newerIncompatible ?? undefined
	};
}

export class HawserUpdateConflictError extends Error {}
export class HawserUpdateNotUpdaterError extends Error {}

export function isHawserUpdatePreparing(envId: number): boolean {
	return preparing.has(envId);
}

/**
 * Re-check the agent server-side, then launch the update on its host. The target
 * is always resolved here, never taken from the client.
 */
export async function runHawserUpdate(
	envId: number,
	send: (event: string, data: unknown) => void
): Promise<{ updaterId: string; check: HawserUpdateCheck }> {
	if (preparing.has(envId)) throw new HawserUpdateConflictError('An update of this agent is already being prepared.');
	preparing.add(envId);
	try {
		const check = await checkHawserUpdate(envId);
		if (check.inFlight?.running) throw new HawserUpdateConflictError('An update of this agent is already running.');
		if (!check.supported) throw new Error(check.reason || 'Updating this agent is not supported.');
		if (!check.updateAvailable || !check.targetImage || !check.containerName) throw new Error('Hawser is already up to date.');

		const env = await getEnvironment(envId);
		const { updaterId } = await launchHawserUpdate(
			remoteDeps(envId),
			{
				containerName: check.containerName,
				currentVersion: check.currentVersion,
				targetImage: check.targetImage,
				edge: env?.connectionType === 'hawser-edge'
			},
			send
		);
		return { updaterId, check };
	} finally {
		preparing.delete(envId);
	}
}

/**
 * Report where a launched update stands. While the agent is offline nothing on
 * the host can be read; once it is back, the updater's exit code decides the
 * outcome and the finished updater container is removed.
 */
export async function getHawserUpdateProgress(envId: number, updaterId: string): Promise<HawserUpdateProgress> {
	const { env } = await loadEnv(envId);
	if (!(await agentReachable(env))) return { agentConnected: false };

	const res = await dockerFetch(`/containers/${encodeURIComponent(updaterId)}/json`, {}, envId);
	if (res.status === 404) return { agentConnected: true, outcome: 'unknown', version: await agentVersion(env) };
	if (!res.ok) throw new Error(`Failed to inspect the updater (${res.status})`);

	const info = (await res.json()) as { State?: { Status?: string; ExitCode?: number }; Config?: { Labels?: Record<string, string> } };
	const labels = info.Config?.Labels || {};
	if (!isHawserUpdater(labels)) throw new HawserUpdateNotUpdaterError('Not a Hawser updater container');
	const outcome = updaterOutcome(info.State?.Status || '', info.State?.ExitCode ?? 0);
	const progress: HawserUpdateProgress = {
		agentConnected: true,
		outcome,
		exitCode: info.State?.ExitCode,
		fromVersion: labels[`${UPDATER_LABEL}.from`] || undefined,
		targetImage: labels[`${UPDATER_LABEL}.target`] || undefined
	};
	if (outcome === 'running') return progress;

	const logs = await dockerFetch(`/containers/${encodeURIComponent(updaterId)}/logs?stdout=true&stderr=true&tail=500`, {}, envId);
	if (logs.ok) progress.logs = demuxDockerStream(Buffer.from(await logs.arrayBuffer()), { interleaved: true }) as string;
	progress.version = await agentVersion(env);
	await dockerFetch(`/containers/${encodeURIComponent(updaterId)}?force=true`, { method: 'DELETE' }, envId).catch(() => {});
	return progress;
}
