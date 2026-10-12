// Run: node --test scripts/journal-footer-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;

/** A temp ledger with two queued rows (one naming AV-266 in repo `proj`) and a temp container whose `proj` repo has a branch for that key. */
function fixture(nowMs = Date.now()): { vault: string; container: string } {
    const root = mkdtempSync(join(tmpdir(), 'fq-'));
    const vault = join(root, 'vault');
    const container = join(root, 'container');
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Journal'), { recursive: true });
    const old = new Date(nowMs - 6 * 864e5).toISOString().slice(0, 10);
    const rows = [
        { id: 'aaaa', ts: `${old}T10:00:00Z`, date: old, kind: 'wip', queued: true, stream: 's', text: 'nothing named here' },
        { id: 'bbbb', ts: new Date(nowMs).toISOString(), date: new Date(nowMs).toISOString().slice(0, 10), kind: 'wip', queued: true, stream: 's', repo: 'proj', text: 'rework AV-266' },
    ];
    writeFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    mkdirSync(join(container, 'proj'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', join(container, 'proj'), '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'chore: init'); git('branch', 'feat/AV-266-x');
    return { vault, container };
}

/** Runs `status --footer` with the clock pinned to `now` and the process in time zone `tz`. */
function footer(now: string, tz: string): string {
    const { vault, container } = fixture(Date.parse(now));
    const r = spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', env: { ...process.env, TZ: tz, MAESTRO_NOW: now, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_CONTAINER_ROOT: container, MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    return r.stdout + r.stderr;
}

const BUILT = /^\*\*Queue:\*\* oldest 6d \(aaaa\); 1 of 2 already built \(branch exists\)$/m;

// Rows carry the UTC day, so the age must not move with the local day: before UTC midnight, between UTC and New York midnight, and after both.
for (const [label, now] of [['before UTC midnight', '2026-10-11T23:30:00Z'], ['after UTC, before local midnight', '2026-10-12T00:18:00Z'], ['after both midnights', '2026-10-12T05:30:00Z']] as const) {
    test(`--footer shows the oldest queued age and the rows that already have a built branch (${label})`, () => {
        for (const tz of ['America/New_York', 'UTC']) assert.match(footer(now, tz), BUILT, `${now} ${tz}`);
    });
}
