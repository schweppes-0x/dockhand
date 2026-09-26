import { describe, it, expect } from 'bun:test';
import { launchHawserUpdate, isHawserUpdater, type LaunchDeps } from '../src/lib/server/hawser-update-launch';

// In-memory remote daemon: answers the Docker API calls the launch makes and
// records every request so the tests can check what was (not) done on the host.
function fakeDocker(opts: { updaterLabels?: Record<string, string>; containers?: unknown[]; updaterStartStatus?: number } = {}) {
	const calls: Array<{ method: string; path: string; body?: any }> = [];
	const hawserInspect = {
		Id: 'oldid',
		Name: '/hawser',
		Config: { Image: 'ghcr.io/finsys/hawser:0.2.9', Env: ['PORT=2376'], Labels: {} },
		HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] },
		Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }],
		NetworkSettings: { Networks: { bridge: {} } }
	};
	const running = [{ Id: 'oldid', Names: ['/hawser'], Image: 'ghcr.io/finsys/hawser:0.2.9', State: 'running' }];
	let created = 0;

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

	const deps: LaunchDeps = {
		async request(path, init = {}) {
			const method = (init.method || 'GET').toUpperCase();
			calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
			if (path === '/version') return json({ Arch: 'amd64', ApiVersion: '1.45' });
			if (path.startsWith('/containers/json?all=true&filters=')) return json([]);
			if (path === '/containers/json?all=true') return json(opts.containers ?? running);
			if (path === '/containers/json') return json(running);
			if (method === 'POST' && path.startsWith('/containers/create')) return json({ Id: created++ === 0 ? 'newid' : 'updaterid' }, 201);
			if (method === 'POST' && path === '/containers/updaterid/start') return new Response('', { status: opts.updaterStartStatus ?? 204 });
			if (method === 'DELETE') return new Response('', { status: 204 });
			return new Response('not found', { status: 404 });
		},
		async pullImage(image) {
			calls.push({ method: 'PULL', path: image });
		},
		async inspectContainer() {
			return hawserInspect;
		},
		async inspectImage() {
			return { Config: { Labels: opts.updaterLabels ?? { 'dockhand.updater.rollback': '1' } } };
		}
	};
	return { deps, calls };
}

const target = {
	containerName: 'hawser',
	currentVersion: '0.2.9',
	targetImage: 'ghcr.io/finsys/hawser:0.2.50'
};
const noop = () => {};

describe('launchHawserUpdate', () => {
	it('pre-creates the new container and starts the updater with rollback, socket bind and labels', async () => {
		const { deps, calls } = fakeDocker();
		const result = await launchHawserUpdate(deps, { ...target, edge: false }, noop);
		expect(result.updaterId).toBe('updaterid');

		const creates = calls.filter((c) => c.method === 'POST' && c.path.startsWith('/containers/create'));
		expect(creates[0].path).toBe('/containers/create?name=hawser-updating');
		expect(creates[0].body.Image).toBe('ghcr.io/finsys/hawser:0.2.50');

		const updater = creates[1].body;
		expect(updater.Image).toBe('fnsys/dockhand-updater:latest');
		expect(updater.Env).toContain('ROLLBACK=1');
		expect(updater.Env).toContain('OLD_CONTAINER_ID=oldid');
		expect(updater.Env).toContain('NEW_CONTAINER_ID=newid');
		expect(updater.Env).toContain('DOCKER_API_VERSION=1.45');
		expect(updater.Env.some((e: string) => e.startsWith('VERIFY_EXEC='))).toBe(false);
		expect(updater.HostConfig).toEqual({ Binds: ['/var/run/docker.sock:/var/run/docker.sock'] });
		expect(updater.Labels['dockhand.hawser-updater']).toBe('true');
		expect(updater.Labels['dockhand.hawser-updater.target']).toBe('ghcr.io/finsys/hawser:0.2.50');
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
	});

	it('makes edge agents prove they reconnected before the old container is removed', async () => {
		const { deps, calls } = fakeDocker();
		await launchHawserUpdate(deps, { ...target, edge: true }, noop);
		const updater = calls.filter((c) => c.path.startsWith('/containers/create'))[1].body;
		expect(updater.Env).toContain(`VERIFY_EXEC=wget -qO- -T 5 http://127.0.0.1:2376/_hawser/health | grep -q '"connected":true'`);
	});

	it('refuses an updater image without rollback support before creating anything', async () => {
		const { deps, calls } = fakeDocker({ updaterLabels: {} });
		await expect(launchHawserUpdate(deps, { ...target, edge: false }, noop)).rejects.toThrow('does not support rollback');
		expect(calls.some((c) => c.path.startsWith('/containers/create'))).toBe(false);
	});

	it('refuses when a -previous container is left over from an earlier update', async () => {
		const { deps, calls } = fakeDocker({
			containers: [
				{ Id: 'oldid', Names: ['/hawser'], Image: 'ghcr.io/finsys/hawser:0.2.9', State: 'running' },
				{ Id: 'prev', Names: ['/hawser-previous'], Image: 'ghcr.io/finsys/hawser:0.2.8', State: 'exited' }
			]
		});
		await expect(launchHawserUpdate(deps, { ...target, edge: false }, noop)).rejects.toThrow('hawser-previous');
		expect(calls.some((c) => c.path.startsWith('/containers/create'))).toBe(false);
	});

	it('removes the pre-created container and the updater when the updater cannot start', async () => {
		const { deps, calls } = fakeDocker({ updaterStartStatus: 500 });
		await expect(launchHawserUpdate(deps, { ...target, edge: false }, noop)).rejects.toThrow('Failed to start the updater');
		const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
		expect(deletes).toContain('/containers/updaterid?force=true');
		expect(deletes).toContain('/containers/newid?force=true');
	});

	it('uses the baseline updater on 32-bit ARM hosts', async () => {
		const { deps, calls } = fakeDocker();
		const request = deps.request;
		deps.request = async (path, init) =>
			path === '/version' ? new Response(JSON.stringify({ Arch: 'arm', ApiVersion: '1.43' })) : request(path, init);
		await launchHawserUpdate(deps, { ...target, edge: false }, noop);
		expect(calls.some((c) => c.method === 'PULL' && c.path === 'fnsys/dockhand-updater:latest-baseline')).toBe(true);
	});
});

describe('isHawserUpdater', () => {
	it('accepts only containers carrying the Hawser updater label', () => {
		expect(isHawserUpdater({ 'dockhand.hawser-updater': 'true' })).toBe(true);
		expect(isHawserUpdater({ 'dockhand.updater': 'true' })).toBe(false);
		expect(isHawserUpdater({})).toBe(false);
		expect(isHawserUpdater(undefined)).toBe(false);
	});
});
