import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment } from '$lib/server/db';
import { auditEnvironment } from '$lib/server/audit';
import { getHawserUpdateProgress, HawserUpdateNotUpdaterError } from '$lib/server/hawser-update';

/**
 * @openapi
 * summary: Poll a launched Hawser update — whether the agent is back, and once it is, the updater's outcome, logs and the agent's version
 * path: id:integer! Environment id (from GET /api/environments)
 * query: updaterId:string! Updater container id (from the "launched" event of POST /api/environments/{id}/hawser-update)
 * resp-200: {agentConnected:boolean!, outcome:string, exitCode:integer, logs:string, version:string, fromVersion:string, targetImage:string}
 * resp-200-desc: outcome is running, updated, failed, rolled_back, rollback_failed or unknown (updater already removed); it is absent while the agent is offline
 * resp-400: updaterId is required, or it is not a Hawser updater container
 * resp-403: Permission denied
 * resp-404: Environment not found
 * resp-500: Failed to read progress
 */
export const GET: RequestHandler = async (event) => {
	const { params, cookies, url } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	const updaterId = url.searchParams.get('updaterId');
	if (!updaterId) return json({ error: 'updaterId is required' }, { status: 400 });

	const env = await getEnvironment(id);
	if (!env) return json({ error: 'Environment not found' }, { status: 404 });

	try {
		const progress = await getHawserUpdateProgress(id, updaterId);
		if (progress.outcome && progress.outcome !== 'running' && progress.outcome !== 'unknown') {
			await auditEnvironment(event, 'update', id, env.name, {
				hawserUpdate: {
					status: progress.outcome,
					fromVersion: progress.fromVersion,
					targetImage: progress.targetImage,
					version: progress.version
				}
			});
		}
		return json(progress);
	} catch (err) {
		if (err instanceof HawserUpdateNotUpdaterError) return json({ error: err.message }, { status: 400 });
		return json({ error: 'Failed to read progress: ' + (err instanceof Error ? err.message : String(err)) }, { status: 500 });
	}
};
