import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { checkHawserUpdate } from '$lib/server/hawser-update';

/**
 * @openapi
 * summary: Check whether the Hawser agent container of an environment can be updated from Dockhand, and to which version
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {supported:boolean!, updateAvailable:boolean!, reason:string, candidates:array<string>, currentVersion:string, currentImage:string, containerName:string, targetImage:string, targetVersion:string, newerIncompatibleVersion:string, isComposeManaged:boolean, inFlight:{updaterId:string, running:boolean, fromVersion:string, targetImage:string}}
 * resp-200-desc: supported:false with a reason covers binary installs, disconnected agents and read-only sockets; inFlight is set while an update is running on the host (running:true) or its result has not been collected yet (running:false)
 * resp-403: Permission denied
 * resp-500: Check failed
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	try {
		return json(await checkHawserUpdate(id));
	} catch (err) {
		console.error(`[HawserUpdate] Check failed for env ${id}:`, err);
		return json({ error: 'Check failed: ' + (err instanceof Error ? err.message : String(err)) }, { status: 500 });
	}
};
