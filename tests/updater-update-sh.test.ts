import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Runs updater/update.sh against a stub `docker` on PATH that records every call and
// answers inspect/exec per container id (via STUB_* env vars), so the swap and
// rollback sequences can be checked without a Docker daemon. The updater image runs
// the script under busybox ash; bash is the closest shell available in CI.
const SCRIPT = fileURLToPath(new URL('../updater/update.sh', import.meta.url));

const STUB = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
cmd=$1; shift
for f in $STUB_FAIL; do
	fcmd=\${f%%:*}; farg=\${f#*:}
	if [ "$cmd" = "$fcmd" ]; then
		for a in "$@"; do
			if [ "$a" = "$farg" ]; then echo "stub: $cmd $farg failed" >&2; exit 1; fi
		done
	fi
done
case "$cmd" in
	inspect)
		fmt=$2; id=$3
		case "$fmt" in
			*Health*) v=STUB_HEALTH_$id; echo "\${!v-healthy}" ;;
			*RestartCount*) v=STUB_RESTARTS_$id; echo "\${!v:-0}" ;;
			*State.Status*) v=STUB_STATUS_$id; echo "\${!v:-running}" ;;
		esac ;;
	exec) v=STUB_EXEC_RC_$1; exit "\${!v:-0}" ;;
	logs) echo "new container log line" ;;
esac
exit 0
`;

let dir: string;
let logFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'updater-test-'));
	logFile = join(dir, 'calls.log');
	writeFileSync(join(dir, 'docker'), STUB);
	chmodSync(join(dir, 'docker'), 0o755);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>) {
	const result = spawnSync('bash', [SCRIPT], {
		env: {
			PATH: `${dir}:${process.env.PATH}`,
			STUB_LOG: logFile,
			OLD_CONTAINER_ID: 'old',
			NEW_CONTAINER_ID: 'new',
			CONTAINER_NAME: 'hawser',
			...env
		},
		encoding: 'utf8'
	});
	const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : [];
	return { code: result.status, out: result.stdout + result.stderr, calls };
}

// Fast verification settings for rollback-mode runs
const FAST = { ROLLBACK: '1', VERIFY_SETTLE: '0', VERIFY_INTERVAL: '0', VERIFY_TIMEOUT: '0' };

describe('update.sh without ROLLBACK (Dockhand self-update)', () => {
	it('keeps the stop → rm → rename → start sequence', () => {
		const { code, calls } = run({});
		expect(code).toBe(0);
		expect(calls.slice(0, 4)).toEqual(['stop -t 30 old', 'rm old', 'rename new hawser', 'start new']);
	});
});

describe('update.sh with ROLLBACK=1', () => {
	it('keeps the old container aside and removes it only after the new one is verified', () => {
		const { code, out, calls } = run(FAST);
		expect(code).toBe(0);
		expect(out).toContain('Update completed successfully!');
		expect(calls).toContain('rename old hawser-previous');
		expect(calls.indexOf('rename new hawser')).toBeGreaterThan(calls.indexOf('rename old hawser-previous'));
		expect(calls.indexOf('rm old')).toBeGreaterThan(calls.indexOf('start new'));
		expect(calls).not.toContain('rm -f new');
	});

	it('connects the new container to the requested networks', () => {
		const { code, calls } = run({ ...FAST, NETWORKS: 'edge_net', NETWORK_OPTS_edge_net: '--alias hawser' });
		expect(code).toBe(0);
		expect(calls).toContain('network connect --alias hawser edge_net new');
	});

	it('rolls back when the new container reports unhealthy', () => {
		const { code, out, calls } = run({ ...FAST, STUB_HEALTH_new: 'unhealthy' });
		expect(code).toBe(2);
		expect(out).toContain('[new] new container log line');
		expect(out).toContain('Rolled back');
		expect(calls).toContain('rm -f new');
		expect(calls.indexOf('rename old hawser')).toBeGreaterThan(calls.indexOf('rm -f new'));
		expect(calls.indexOf('start old')).toBeGreaterThan(calls.indexOf('rename old hawser'));
		expect(calls).not.toContain('rm old');
	});

	it('rolls back when the new container restarts', () => {
		const { code } = run({ ...FAST, STUB_RESTARTS_new: '1' });
		expect(code).toBe(2);
	});

	it('rolls back when the new container is not running', () => {
		const { code } = run({ ...FAST, STUB_STATUS_new: 'exited' });
		expect(code).toBe(2);
	});

	it('rolls back when the health check never turns healthy in time', () => {
		const { code, out } = run({ ...FAST, STUB_HEALTH_new: 'starting' });
		expect(code).toBe(2);
		expect(out).toContain('timed out');
	});

	it('rolls back when VERIFY_EXEC keeps failing', () => {
		const { code, calls } = run({ ...FAST, VERIFY_EXEC: 'true', STUB_EXEC_RC_new: '1' });
		expect(code).toBe(2);
		expect(calls).toContain('exec new sh -c true');
	});

	it('accepts a container without a health check once VERIFY_EXEC passes', () => {
		const { code, calls } = run({ ...FAST, STUB_HEALTH_new: '', VERIFY_EXEC: 'true' });
		expect(code).toBe(0);
		expect(calls).toContain('exec new sh -c true');
	});

	it('rolls back when the new container fails to start', () => {
		const { code, calls } = run({ ...FAST, STUB_FAIL: 'start:new' });
		expect(code).toBe(2);
		expect(calls).toContain('start old');
	});

	it('rolls back when renaming the new container fails', () => {
		const { code, calls } = run({ ...FAST, STUB_FAIL: 'rename:new' });
		expect(code).toBe(2);
		expect(calls).toContain('rename old hawser');
		expect(calls).toContain('start old');
	});

	it('does not rename the old container back if it was never renamed', () => {
		const { code, calls } = run({ ...FAST, STUB_FAIL: 'rename:old' });
		expect(code).toBe(2);
		expect(calls).not.toContain('rename old hawser');
		expect(calls).toContain('start old');
	});

	it('exits 3 and asks for manual intervention when the rollback fails', () => {
		const { code, out } = run({ ...FAST, STUB_HEALTH_new: 'unhealthy', STUB_FAIL: 'start:old' });
		expect(code).toBe(3);
		expect(out).toContain('manual intervention required');
		expect(out).toContain('hawser-previous');
	});

	it('exits 1 without touching anything else when the old container cannot be stopped', () => {
		const { code, calls } = run({ ...FAST, STUB_FAIL: 'stop:old' });
		expect(code).toBe(1);
		expect(calls).toEqual(['stop -t 30 old']);
	});

	it('still reports success when the previous container cannot be removed', () => {
		const { code, out } = run({ ...FAST, STUB_FAIL: 'rm:old' });
		expect(code).toBe(0);
		expect(out).toContain('Warning');
	});
});
