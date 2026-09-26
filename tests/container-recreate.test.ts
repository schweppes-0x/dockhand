import { describe, it, expect } from 'bun:test';
import { buildCreateConfig, buildNetworkEnvVars } from '../src/lib/server/container-recreate';

describe('buildCreateConfig', () => {
	const inspect = {
		Config: {
			Image: 'ghcr.io/finsys/hawser:0.2.9',
			Env: ['TOKEN=x'],
			Hostname: 'abc123',
			MacAddress: '02:42:ac:11:00:02',
			Entrypoint: ['/usr/local/bin/hawser'],
			Cmd: ['standard'],
			Labels: { a: 'b' }
		},
		HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'], RestartPolicy: { Name: 'unless-stopped' } },
		Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }]
	};

	it('swaps the image and keeps config and host config', () => {
		const cfg = buildCreateConfig(inspect, 'ghcr.io/finsys/hawser:0.3.0');
		expect(cfg.Image).toBe('ghcr.io/finsys/hawser:0.3.0');
		expect(cfg.Env).toEqual(['TOKEN=x']);
		expect(cfg.Labels).toEqual({ a: 'b' });
		expect(cfg.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
		expect(cfg.HostConfig.Binds).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
	});

	it('drops fields that must come from the new image or the new container', () => {
		const cfg = buildCreateConfig(inspect, 'img:new');
		expect(cfg.Entrypoint).toBeUndefined();
		expect(cfg.Cmd).toBeUndefined();
		expect(cfg.Hostname).toBeUndefined();
		expect(cfg.MacAddress).toBeUndefined();
	});

	it('never sets NetworkingConfig', () => {
		expect(buildCreateConfig(inspect, 'img:new').NetworkingConfig).toBeUndefined();
	});
});

describe('buildNetworkEnvVars', () => {
	it('returns nothing without networks', () => {
		expect(buildNetworkEnvVars({})).toEqual([]);
	});

	it('lists networks and per-network options with safe env names', () => {
		const env = buildNetworkEnvVars({
			NetworkSettings: {
				Networks: {
					bridge: {},
					'my-net.v2': { IPAMConfig: { IPv4Address: '10.0.0.5' }, Aliases: ['hawser'] }
				}
			}
		});
		expect(env).toEqual(['NETWORKS=bridge my-net.v2', 'NETWORK_OPTS_my_net_v2=--ip 10.0.0.5 --alias hawser']);
	});
});
