/**
 * Pure helpers for updating a Docker-deployed Hawser agent from Dockhand.
 *
 * Dockhand pulls the new image and pre-creates the replacement container through
 * the agent, then starts the updater sidecar on the remote host with ROLLBACK=1 so
 * a new agent that doesn't come back is swapped out for the old one again.
 */
import { isHawserContainer } from './scheduler/tasks/update-utils';
import { updaterImageForVariant } from './updater-image-core';

export interface ContainerSummary {
	Id: string;
	Names?: string[];
	Image: string;
	State: string;
	Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string }>;
}

export type Selection<T> = ({ ok: true } & T) | { ok: false; reason: string; candidates?: string[] };

const containerName = (c: ContainerSummary) => (c.Names?.[0] || c.Id.substring(0, 12)).replace(/^\//, '');

/**
 * Find the container the agent itself runs in. Edge agents report their hostname,
 * which Docker sets to the short container id; standard agents are matched by the
 * published port Dockhand connects to.
 */
export function selectHawserContainer(
	containers: ContainerSummary[],
	hints: { edgeHostname?: string; port?: number }
): Selection<{ id: string; name: string }> {
	let candidates = containers.filter((c) => c.State === 'running' && isHawserContainer(c.Image || ''));
	if (candidates.length === 0) {
		return {
			ok: false,
			reason: 'Hawser is not running as a Docker container on this host. Binary (systemd) installs must be updated on the host.'
		};
	}

	if (candidates.length > 1 && hints.edgeHostname) {
		const byHost = candidates.filter((c) => c.Id.startsWith(hints.edgeHostname!));
		if (byHost.length > 0) candidates = byHost;
	}
	if (candidates.length > 1 && hints.port) {
		const byPort = candidates.filter((c) => c.Ports?.some((p) => p.PublicPort === hints.port));
		if (byPort.length > 0) candidates = byPort;
	}

	if (candidates.length > 1) {
		return {
			ok: false,
			reason: 'Several Hawser containers run on this host and the agent could not be matched to one of them.',
			candidates: candidates.map(containerName)
		};
	}
	return { ok: true, id: candidates[0].Id, name: containerName(candidates[0]) };
}

export type HawserImage =
	| { kind: 'digest' }
	| { kind: 'floating'; repo: string; tag: string }
	| { kind: 'version'; repo: string; prefix: string; version: string; suffix: string };

/** Split an image reference into repo + tag and classify the tag (release tags are bare semver, optionally arch-suffixed). */
export function parseHawserImage(image: string): HawserImage {
	if (image.includes('@sha256:')) return { kind: 'digest' };

	const lastSlash = image.lastIndexOf('/');
	const colon = image.lastIndexOf(':');
	const hasTag = colon > lastSlash;
	const repo = hasTag ? image.substring(0, colon) : image;
	const tag = hasTag ? image.substring(colon + 1) : 'latest';

	const match = tag.match(/^(v?)(\d+\.\d+\.\d+)(-(?:amd64|arm64|armv7))?$/);
	if (match) {
		return { kind: 'version', repo, prefix: match[1], version: match[2], suffix: match[3] || '' };
	}
	return { kind: 'floating', repo, tag };
}

type Semver = [number, number, number];

function parseSemver(v: string): Semver | null {
	const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: Semver, b: Semver): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Caret compatibility (npm ^): same major, and on 0.x also the same minor. */
function isCompatible(current: Semver, candidate: Semver): boolean {
	if (candidate[0] !== current[0]) return false;
	return current[0] !== 0 || candidate[1] === current[1];
}

/**
 * Newest release compatible with the current version, plus the newest release
 * overall when it is newer but outside the compatible range (shown, never applied).
 */
export function pickCompatibleRelease(
	currentVersion: string,
	releaseTags: string[]
): { target: string | null; newerIncompatible: string | null } {
	const current = parseSemver(currentVersion);
	if (!current) return { target: null, newerIncompatible: null };

	const newer = releaseTags
		.map(parseSemver)
		.filter((v): v is Semver => v !== null && cmp(v, current) > 0)
		.sort((a, b) => cmp(b, a));

	const target = newer.find((v) => isCompatible(current, v)) || null;
	const newest = newer[0] && !isCompatible(current, newer[0]) ? newer[0] : null;
	return { target: target && target.join('.'), newerIncompatible: newest && newest.join('.') };
}

function envValue(env: string[] | undefined, key: string): string | undefined {
	const entry = env?.find((e) => e.startsWith(`${key}=`));
	return entry?.substring(key.length + 1);
}

/**
 * Host path of the Docker socket Hawser uses, which the updater sidecar needs to
 * bind-mount to do the swap on the same daemon.
 */
export function findSocketMount(inspect: {
	Config?: { Env?: string[] };
	Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>;
}): Selection<{ hostPath: string }> {
	const env = inspect.Config?.Env;
	if (envValue(env, 'DOCKER_HOST')) {
		return { ok: false, reason: 'Hawser reaches Docker through DOCKER_HOST. Updating from Dockhand needs the Docker socket bind-mounted into the Hawser container.' };
	}

	const socketPath = envValue(env, 'DOCKER_SOCKET') || '/var/run/docker.sock';
	const mount = inspect.Mounts?.find((m) => m.Destination === socketPath);
	if (!mount?.Source) {
		return { ok: false, reason: `The Hawser container has no bind mount for its Docker socket (${socketPath}).` };
	}
	if (mount.RW === false) {
		return { ok: false, reason: 'The Docker socket is mounted read-only into the Hawser container. Updating needs read-write access.' };
	}
	return { ok: true, hostPath: mount.Source };
}

/**
 * The updater image for the remote host. Hawser's 64-bit images are Wolfi like the
 * default updater, so any host running them can run it; the armv7 Hawser image is
 * Alpine, matching the baseline updater.
 */
export function hawserUpdaterImage(remoteArch: string): string {
	return updaterImageForVariant(remoteArch === 'arm' ? 'baseline' : undefined);
}

/**
 * Command the updater runs inside the new edge agent: succeeds once the agent's
 * health endpoint (always plain HTTP) reports a live connection to Dockhand.
 */
export function buildEdgeVerifyExec(env: string[]): string {
	const port = envValue(env, 'PORT') || '2376';
	const bind = envValue(env, 'BIND_ADDRESS') || '0.0.0.0';
	let host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
	if (host.includes(':')) host = `[${host}]`;
	return `wget -qO- -T 5 http://${host}:${port}/_hawser/health | grep -q '"connected":true'`;
}

export function buildUpdaterEnv(opts: {
	oldId: string;
	newId: string;
	name: string;
	networkEnv: string[];
	apiVersion?: string;
	verifyExec?: string;
}): string[] {
	const env = [`OLD_CONTAINER_ID=${opts.oldId}`, `NEW_CONTAINER_ID=${opts.newId}`, `CONTAINER_NAME=${opts.name}`, 'ROLLBACK=1', ...opts.networkEnv];
	if (opts.apiVersion) env.push(`DOCKER_API_VERSION=${opts.apiVersion}`);
	if (opts.verifyExec) env.push(`VERIFY_EXEC=${opts.verifyExec}`);
	return env;
}

export type HawserUpdateOutcome = 'running' | 'updated' | 'failed' | 'rolled_back' | 'rollback_failed';

/** Map the updater sidecar's state and exit code (see updater/update.sh) to a result. */
export function updaterOutcome(status: string, exitCode: number): HawserUpdateOutcome {
	if (status !== 'exited') return 'running';
	switch (exitCode) {
		case 0:
			return 'updated';
		case 2:
			return 'rolled_back';
		case 3:
			return 'rollback_failed';
		default:
			return 'failed';
	}
}
