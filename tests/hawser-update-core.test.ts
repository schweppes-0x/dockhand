import { describe, it, expect } from 'bun:test';
import {
	selectHawserContainer,
	parseHawserImage,
	pickCompatibleRelease,
	findSocketMount,
	hawserUpdaterImage,
	buildEdgeVerifyExec,
	buildUpdaterEnv,
	updaterOutcome
} from '../src/lib/server/hawser-update-core';

const hawser = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	Id: id,
	Names: [`/${name}`],
	Image: 'ghcr.io/finsys/hawser:latest',
	State: 'running',
	...extra
});

describe('selectHawserContainer', () => {
	it('picks the only running Hawser container', () => {
		const result = selectHawserContainer([hawser('abc123', 'hawser'), { Id: 'x', Names: ['/nginx'], Image: 'nginx', State: 'running' }], {});
		expect(result).toEqual({ ok: true, id: 'abc123', name: 'hawser' });
	});

	it('ignores stopped Hawser containers', () => {
		const result = selectHawserContainer([hawser('old', 'hawser-old', { State: 'exited' }), hawser('abc', 'hawser')], {});
		expect(result).toEqual({ ok: true, id: 'abc', name: 'hawser' });
	});

	it('reports a binary install when no Hawser container runs', () => {
		const result = selectHawserContainer([{ Id: 'x', Names: ['/nginx'], Image: 'nginx', State: 'running' }], {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('not running as a Docker container');
	});

	it('uses the edge hostname (short container id) to pick between several', () => {
		const result = selectHawserContainer([hawser('aaa111', 'hawser-a'), hawser('bbb222', 'hawser-b')], { edgeHostname: 'bbb222' });
		expect(result).toEqual({ ok: true, id: 'bbb222', name: 'hawser-b' });
	});

	it('uses the published port to pick between several standard agents', () => {
		const result = selectHawserContainer(
			[
				hawser('aaa', 'hawser-a', { Ports: [{ PrivatePort: 2376, PublicPort: 2376, Type: 'tcp' }] }),
				hawser('bbb', 'hawser-b', { Ports: [{ PrivatePort: 2376, PublicPort: 2377, Type: 'tcp' }] })
			],
			{ port: 2377 }
		);
		expect(result).toEqual({ ok: true, id: 'bbb', name: 'hawser-b' });
	});

	it('refuses to guess when several remain and lists them', () => {
		const result = selectHawserContainer([hawser('aaa', 'hawser-a'), hawser('bbb', 'hawser-b')], {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.candidates).toEqual(['hawser-a', 'hawser-b']);
	});
});

describe('parseHawserImage', () => {
	it('treats latest and no tag as floating', () => {
		expect(parseHawserImage('ghcr.io/finsys/hawser:latest')).toEqual({ kind: 'floating', repo: 'ghcr.io/finsys/hawser', tag: 'latest' });
		expect(parseHawserImage('ghcr.io/finsys/hawser')).toEqual({ kind: 'floating', repo: 'ghcr.io/finsys/hawser', tag: 'latest' });
		expect(parseHawserImage('ghcr.io/finsys/hawser:latest-arm64').kind).toBe('floating');
	});

	it('parses a pinned version with optional v prefix and arch suffix', () => {
		expect(parseHawserImage('ghcr.io/finsys/hawser:0.2.9')).toEqual({
			kind: 'version',
			repo: 'ghcr.io/finsys/hawser',
			prefix: '',
			version: '0.2.9',
			suffix: ''
		});
		expect(parseHawserImage('ghcr.io/finsys/hawser:v0.2.9-arm64')).toEqual({
			kind: 'version',
			repo: 'ghcr.io/finsys/hawser',
			prefix: 'v',
			version: '0.2.9',
			suffix: '-arm64'
		});
	});

	it('keeps a registry port out of the tag', () => {
		expect(parseHawserImage('registry.local:5000/finsys/hawser')).toEqual({
			kind: 'floating',
			repo: 'registry.local:5000/finsys/hawser',
			tag: 'latest'
		});
		expect(parseHawserImage('registry.local:5000/finsys/hawser:1.0.0').kind).toBe('version');
	});

	it('recognises digest-pinned images', () => {
		expect(parseHawserImage('ghcr.io/finsys/hawser@sha256:abc').kind).toBe('digest');
	});
});

describe('pickCompatibleRelease', () => {
	const tags = ['v0.2.50', 'v0.2.49', 'v0.3.1', 'v1.2.0', 'v1.4.0', 'v2.0.0', 'nightly'];

	it('stays within the 0.minor line for 0.x versions', () => {
		expect(pickCompatibleRelease('0.2.9', tags)).toEqual({ target: '0.2.50', newerIncompatible: '2.0.0' });
	});

	it('stays within the major line for 1.x and later', () => {
		expect(pickCompatibleRelease('1.2.0', tags)).toEqual({ target: '1.4.0', newerIncompatible: '2.0.0' });
	});

	it('returns no target when already on the newest compatible release', () => {
		expect(pickCompatibleRelease('2.0.0', tags)).toEqual({ target: null, newerIncompatible: null });
	});

	it('ignores releases older than the current version', () => {
		expect(pickCompatibleRelease('0.2.50', ['v0.2.49'])).toEqual({ target: null, newerIncompatible: null });
	});
});

describe('findSocketMount', () => {
	const inspect = (env: string[], mounts: unknown[]) => ({ Config: { Env: env }, Mounts: mounts });
	const sock = { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true };

	it('returns the host path of the Docker socket bind mount', () => {
		expect(findSocketMount(inspect([], [sock]))).toEqual({ ok: true, hostPath: '/var/run/docker.sock' });
	});

	it('follows a custom DOCKER_SOCKET path', () => {
		const custom = { ...sock, Source: '/run/user/1000/docker.sock', Destination: '/docker.sock' };
		expect(findSocketMount(inspect(['DOCKER_SOCKET=/docker.sock'], [sock, custom]))).toEqual({
			ok: true,
			hostPath: '/run/user/1000/docker.sock'
		});
	});

	it('rejects a read-only socket mount', () => {
		const result = findSocketMount(inspect([], [{ ...sock, RW: false }]));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('read-only');
	});

	it('rejects Hawser reaching Docker over DOCKER_HOST', () => {
		const result = findSocketMount(inspect(['DOCKER_HOST=tcp://proxy:2375'], []));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('DOCKER_HOST');
	});

	it('rejects a missing socket mount', () => {
		expect(findSocketMount(inspect([], [])).ok).toBe(false);
	});
});

describe('hawserUpdaterImage', () => {
	it('uses the Alpine (baseline) updater on 32-bit ARM, where Hawser is Alpine too', () => {
		expect(hawserUpdaterImage('arm')).toBe('fnsys/dockhand-updater:latest-baseline');
	});

	it('uses the default updater elsewhere', () => {
		expect(hawserUpdaterImage('amd64')).toBe('fnsys/dockhand-updater:latest');
		expect(hawserUpdaterImage('arm64')).toBe('fnsys/dockhand-updater:latest');
	});
});

describe('buildEdgeVerifyExec', () => {
	it('checks the health endpoint on the default port for a live Dockhand connection', () => {
		expect(buildEdgeVerifyExec([])).toBe(`wget -qO- -T 5 http://127.0.0.1:2376/_hawser/health | grep -q '"connected":true'`);
	});

	it('follows PORT and a specific BIND_ADDRESS', () => {
		expect(buildEdgeVerifyExec(['PORT=9000', 'BIND_ADDRESS=10.0.0.4'])).toContain('http://10.0.0.4:9000/_hawser/health');
	});

	it('uses loopback for wildcard bind addresses', () => {
		expect(buildEdgeVerifyExec(['BIND_ADDRESS=::'])).toContain('http://127.0.0.1:2376/');
	});

	it('brackets an IPv6 bind address', () => {
		expect(buildEdgeVerifyExec(['BIND_ADDRESS=fd00::4'])).toContain('http://[fd00::4]:2376/');
	});
});

describe('buildUpdaterEnv', () => {
	it('enables rollback and passes through ids, networks, API version and verify command', () => {
		expect(
			buildUpdaterEnv({
				oldId: 'old',
				newId: 'new',
				name: 'hawser',
				networkEnv: ['NETWORKS=bridge'],
				apiVersion: '1.43',
				verifyExec: 'true'
			})
		).toEqual([
			'OLD_CONTAINER_ID=old',
			'NEW_CONTAINER_ID=new',
			'CONTAINER_NAME=hawser',
			'ROLLBACK=1',
			'NETWORKS=bridge',
			'DOCKER_API_VERSION=1.43',
			'VERIFY_EXEC=true'
		]);
	});

	it('omits optional values that are not set', () => {
		expect(buildUpdaterEnv({ oldId: 'o', newId: 'n', name: 'h', networkEnv: [] })).toEqual([
			'OLD_CONTAINER_ID=o',
			'NEW_CONTAINER_ID=n',
			'CONTAINER_NAME=h',
			'ROLLBACK=1'
		]);
	});
});

describe('updaterOutcome', () => {
	it('is running while the updater has not exited', () => {
		expect(updaterOutcome('running', 0)).toBe('running');
	});

	it('maps the updater exit codes', () => {
		expect(updaterOutcome('exited', 0)).toBe('updated');
		expect(updaterOutcome('exited', 1)).toBe('failed');
		expect(updaterOutcome('exited', 2)).toBe('rolled_back');
		expect(updaterOutcome('exited', 3)).toBe('rollback_failed');
	});

	it('treats any other exit code as a failure', () => {
		expect(updaterOutcome('exited', 127)).toBe('failed');
	});
});
