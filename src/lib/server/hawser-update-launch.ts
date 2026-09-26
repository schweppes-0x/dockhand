/**
 * The launch half of a Hawser update: everything done on the agent's host before
 * the updater sidecar takes over. Docker access is passed in (bound to the
 * environment) so the sequence can be tested without a daemon or the database.
 */
import { buildCreateConfig, buildNetworkEnvVars } from './container-recreate';
import {
	findSocketMount,
	hawserUpdaterImage,
	buildEdgeVerifyExec,
	buildUpdaterEnv,
	type ContainerSummary
} from './hawser-update-core';

export const UPDATER_LABEL = 'dockhand.hawser-updater';
const ROLLBACK_LABEL = 'dockhand.updater.rollback';

export interface LaunchDeps {
	request(path: string, init?: RequestInit): Promise<Response>;
	pullImage(image: string, onProgress?: (data: any) => void): Promise<void>;
	inspectContainer(id: string): Promise<any>;
	inspectImage(image: string): Promise<any>;
}

export interface LaunchTarget {
	containerName: string;
	currentVersion?: string;
	targetImage: string;
	edge: boolean;
}

type Send = (event: string, data: unknown) => void;

export async function remoteJson<T>(deps: LaunchDeps, path: string, init: RequestInit = {}): Promise<T> {
	const res = await deps.request(path, init);
	if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
	return (await res.json()) as T;
}

export async function listUpdaters(deps: LaunchDeps): Promise<Array<{ Id: string; State: string; Labels?: Record<string, string> }>> {
	const filters = encodeURIComponent(JSON.stringify({ label: [`${UPDATER_LABEL}=true`] }));
	return remoteJson(deps, `/containers/json?all=true&filters=${filters}`);
}

/**
 * Pull the target image, pre-create the replacement container and start the
 * updater sidecar. Anything that fails before the sidecar starts leaves the
 * running agent untouched and removes what was created.
 */
export async function launchHawserUpdate(deps: LaunchDeps, target: LaunchTarget, send: Send): Promise<{ updaterId: string }> {
	const step = (id: string, status: string, message: string) => send('step', { step: id, status, message });
	const log = (message: string) => send('log', { message });
	const { containerName: name, targetImage } = target;
	let newContainerId: string | null = null;
	let updaterId: string | null = null;

	try {
		step('pulling_image', 'active', `Pulling ${targetImage}...`);
		await deps.pullImage(targetImage, (data) => {
			if (data?.status) log(`${data.id ? `${data.id}: ` : ''}${data.status}${data.progress ? ` ${data.progress}` : ''}`);
		});
		step('pulling_image', 'completed', 'Image pulled');

		step('building_config', 'active', 'Building container config...');
		const running = await remoteJson<ContainerSummary[]>(deps, '/containers/json');
		const current = running.find((c) => c.Names?.some((n) => n === `/${name}`));
		if (!current) throw new Error(`Hawser container ${name} is no longer running.`);
		const inspect = await deps.inspectContainer(current.Id);
		const socket = findSocketMount(inspect);
		if (!socket.ok) throw new Error(socket.reason);
		const createConfig = buildCreateConfig(inspect, targetImage);
		const networkEnv = buildNetworkEnvVars(inspect);
		const version = await remoteJson<{ Arch?: string; ApiVersion?: string }>(deps, '/version');
		log(`Host: ${version.Arch || 'unknown'} (Docker API ${version.ApiVersion || 'unknown'})`);
		step('building_config', 'completed', 'Config ready');

		const updaterImage = hawserUpdaterImage(version.Arch || '');
		step('pulling_updater', 'active', `Pulling ${updaterImage}...`);
		await deps.pullImage(updaterImage);
		const updaterInfo = await deps.inspectImage(updaterImage);
		if (updaterInfo?.Config?.Labels?.[ROLLBACK_LABEL] !== '1') {
			throw new Error(`${updaterImage} does not support rollback yet, so the agent was not touched. Pull a newer updater image and try again.`);
		}
		step('pulling_updater', 'completed', 'Updater ready');

		step('creating_container', 'active', 'Creating new container...');
		for (const leftover of await listUpdaters(deps)) {
			await deps.request(`/containers/${leftover.Id}?force=true`, { method: 'DELETE' }).catch(() => {});
		}
		const all = await remoteJson<ContainerSummary[]>(deps, '/containers/json?all=true');
		const byName = (n: string) => all.find((c) => c.Names?.some((x) => x === `/${n}`));
		if (byName(`${name}-previous`)) {
			throw new Error(`A container named ${name}-previous exists on the host, probably from an earlier failed update. Remove it and try again.`);
		}
		const stale = byName(`${name}-updating`);
		if (stale) await deps.request(`/containers/${stale.Id}?force=true`, { method: 'DELETE' });

		newContainerId = (
			await remoteJson<{ Id: string }>(deps, `/containers/create?name=${encodeURIComponent(`${name}-updating`)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(createConfig)
			})
		).Id;
		log(`Container created: ${newContainerId.substring(0, 12)} (${name}-updating)`);
		step('creating_container', 'completed', 'Container created');

		step('launching_updater', 'active', 'Launching updater...');
		const updaterEnv = buildUpdaterEnv({
			oldId: current.Id,
			newId: newContainerId,
			name,
			networkEnv,
			apiVersion: version.ApiVersion,
			verifyExec: target.edge ? buildEdgeVerifyExec(inspect.Config?.Env || []) : undefined
		});
		updaterId = (
			await remoteJson<{ Id: string }>(deps, '/containers/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					Image: updaterImage,
					Env: updaterEnv,
					Labels: {
						[UPDATER_LABEL]: 'true',
						[`${UPDATER_LABEL}.from`]: target.currentVersion || '',
						[`${UPDATER_LABEL}.target`]: targetImage
					},
					HostConfig: { Binds: [`${socket.hostPath}:/var/run/docker.sock`] }
				})
			})
		).Id;
		const start = await deps.request(`/containers/${updaterId}/start`, { method: 'POST' });
		if (!start.ok) throw new Error(`Failed to start the updater: ${await start.text()}`);
		step('launching_updater', 'completed', 'Updater launched');
		log(`Updater started: ${updaterId.substring(0, 12)}. The agent will go offline while it is replaced.`);
		return { updaterId };
	} catch (err) {
		for (const id of [updaterId, newContainerId]) {
			if (id) await deps.request(`/containers/${id}?force=true`, { method: 'DELETE' }).catch(() => {});
		}
		throw err;
	}
}
