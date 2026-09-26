/**
 * Hawser agent update checks, per environment.
 *
 * Checks only run where an update control is shown (edit modal, container
 * details), never for a whole list, so opening Settings → Environments doesn't
 * hit the registry or GitHub once per agent. The environments table reads the
 * results that are already here.
 */
import { writable } from 'svelte/store';

export interface HawserUpdateCheck {
	supported: boolean;
	updateAvailable: boolean;
	reason?: string;
	candidates?: string[];
	currentVersion?: string;
	currentImage?: string;
	containerName?: string;
	targetImage?: string;
	targetVersion?: string;
	newerIncompatibleVersion?: string;
	isComposeManaged?: boolean;
	inFlight?: { updaterId: string; running: boolean; fromVersion?: string; targetImage?: string };
	error?: string;
}

export const hawserUpdateChecks = writable<Record<number, HawserUpdateCheck>>({});

/** Launched updates by environment, kept while the dialog is closed so reopening resumes them. */
export const launchedHawserUpdates = new Map<number, { updaterId: string; startedAt: number }>();

/** Record a launched update so every control for this environment shows it as in progress. */
export function markHawserUpdateLaunched(envId: number, updaterId: string, startedAt = Date.now()): void {
	launchedHawserUpdates.set(envId, { updaterId, startedAt });
	hawserUpdateChecks.update((all) => ({
		...all,
		[envId]: { ...(all[envId] ?? { supported: true, updateAvailable: false }), inFlight: { updaterId, running: true } }
	}));
}

export async function checkHawserUpdate(envId: number): Promise<HawserUpdateCheck> {
	let result: HawserUpdateCheck;
	try {
		const res = await fetch(`/api/environments/${envId}/hawser-update/check`);
		const data = await res.json();
		result = res.ok ? data : { supported: false, updateAvailable: false, error: data.error || `HTTP ${res.status}` };
	} catch (err) {
		result = { supported: false, updateAvailable: false, error: String(err) };
	}
	hawserUpdateChecks.update((all) => ({ ...all, [envId]: result }));
	return result;
}
