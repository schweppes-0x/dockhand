/**
 * Build a replacement container from a running container's inspect data. Shared by
 * Dockhand self-update and the remote Hawser update, which both pre-create the new
 * container and hand the stop/rename/start swap to the updater sidecar.
 */
import { getAdditionalVolumeBinds, dedupeVolumesForRecreate } from './mount-dedupe';

/**
 * Build the container create config from inspect data (same logic as recreateContainerFromInspect).
 * Does NOT include NetworkingConfig — the new container is created without networks
 * to avoid static IP conflicts with the still-running old container.
 */
export function buildCreateConfig(inspectData: any, newImage: string): any {
	const config = inspectData.Config || {};
	const hostConfig = inspectData.HostConfig || {};

	const createConfig: any = {
		...config,
		Image: newImage,
		HostConfig: { ...hostConfig }
	};

	// Clear MacAddress for Docker API < 1.44 compatibility
	delete createConfig.MacAddress;

	// Clear Entrypoint and Cmd so the new image's defaults are used.
	// This prevents carrying over a stale entrypoint from a previous runtime
	// (e.g. Bun's docker-entrypoint.sh → Node.js docker-entrypoint-node.sh).
	delete createConfig.Entrypoint;
	delete createConfig.Cmd;

	// Clear Hostname so Docker assigns the new container's own ID
	// Otherwise the old container's hostname is inherited, breaking self-identification
	delete createConfig.Hostname;

	const additionalBinds = getAdditionalVolumeBinds(hostConfig, inspectData.Mounts || []);
	// Drop image-VOLUME entries that collide with a bind/tmpfs/inspect mount, so create never
	// sends a duplicate mount point (#1088 / #1363).
	const kept = dedupeVolumesForRecreate(createConfig.Volumes, hostConfig, inspectData.Mounts || [], additionalBinds);
	if (kept) createConfig.Volumes = kept;
	else delete createConfig.Volumes;
	if (additionalBinds.length > 0) {
		createConfig.HostConfig = {
			...createConfig.HostConfig,
			Binds: [...(createConfig.HostConfig.Binds || []), ...additionalBinds]
		};
	}

	// No NetworkingConfig — avoids static IP conflicts with still-running old container.
	// Networks are connected by the sidecar after the old container is removed.

	return createConfig;
}

/**
 * Build NETWORKS and NETWORK_OPTS_* env vars from inspect data's NetworkSettings.
 * The sidecar uses these to reconnect networks via `docker network connect` CLI.
 */
export function buildNetworkEnvVars(inspectData: any): string[] {
	const networks: Record<string, any> = inspectData.NetworkSettings?.Networks || {};
	const entries = Object.entries(networks);
	if (entries.length === 0) return [];

	const networkNames: string[] = [];
	const envVars: string[] = [];

	for (const [netName, netConfig] of entries) {
		networkNames.push(netName);

		const nc = netConfig as any;
		const opts: string[] = [];

		if (nc.IPAMConfig?.IPv4Address) {
			opts.push(`--ip ${nc.IPAMConfig.IPv4Address}`);
		}
		if (nc.IPAMConfig?.IPv6Address) {
			opts.push(`--ip6 ${nc.IPAMConfig.IPv6Address}`);
		}
		if (nc.Aliases && nc.Aliases.length > 0) {
			for (const alias of nc.Aliases) {
				opts.push(`--alias ${alias}`);
			}
		}
		if (nc.Links && nc.Links.length > 0) {
			for (const link of nc.Links) {
				opts.push(`--link ${link}`);
			}
		}

		if (opts.length > 0) {
			// Env var name: dots and dashes become underscores
			const safeNetName = netName.replace(/[.-]/g, '_');
			envVars.push(`NETWORK_OPTS_${safeNetName}=${opts.join(' ')}`);
		}
	}

	envVars.unshift(`NETWORKS=${networkNames.join(' ')}`);
	return envVars;
}
