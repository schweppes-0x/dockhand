import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment } from '$lib/server/db';
import { auditEnvironment } from '$lib/server/audit';
import { prefersJSON, sseToJSON } from '$lib/server/sse';
import { runHawserUpdate, isHawserUpdatePreparing } from '$lib/server/hawser-update';

/**
 * @openapi
 * summary: Update the environment's Hawser agent container — pull the new image through the agent, then hand off to an updater sidecar on the agent's host that swaps the containers and rolls back if the new agent does not come back
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: text/event-stream SSE response (steps: pulling_image, building_config, pulling_updater, creating_container, launching_updater, then a "launched" {updaterId} or "error" event, and a final "result" {success, updaterId|error}) — or, with "Accept: application/json", that result as plain JSON
 * resp-403: Permission denied
 * resp-404: Environment not found
 * resp-409: An update of this agent is already being prepared
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies, request } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	const env = await getEnvironment(id);
	if (!env) return json({ error: 'Environment not found' }, { status: 404 });
	if (isHawserUpdatePreparing(id)) {
		return json({ error: 'An update of this agent is already being prepared' }, { status: 409 });
	}

	const encoder = new TextEncoder();
	let closed = false;
	const stream = new ReadableStream({
		async start(controller) {
			const send = (name: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			try {
				const { updaterId, check } = await runHawserUpdate(id, send);
				await auditEnvironment(event, 'update', id, env.name, {
					hawserUpdate: { status: 'launched', fromVersion: check.currentVersion, targetImage: check.targetImage }
				});
				send('launched', { updaterId });
				send('result', { success: true, updaterId });
			} catch (err) {
				console.error(`[HawserUpdate] Env ${id}:`, err);
				const message = err instanceof Error ? err.message : String(err);
				send('error', { step: 'preparation', message });
				send('result', { success: false, error: message });
			} finally {
				if (!closed) {
					try { controller.close(); } catch { /* already closed */ }
				}
			}
		}
	});

	const sseResponse = new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
	if (prefersJSON(request)) return sseToJSON(sseResponse);
	return sseResponse;
};
