// Run: node --test scripts/journal-footer-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;

/** A temp ledger with two queued rows (one naming MAESTRO-266 in repo `proj`) and a temp container whose `proj` repo has a branch for that key. */
function fixture(): { vault: string; container: string } {
    const root = mkdtempSync(join(tmpdir(), 'fq-'));
    const vault = join(root, 'vault');
    const container = join(root, 'container');
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Journal'), { recursive: true });
    const old = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const rows = [
        { id: 'aaaa', ts: `${old}T10:00:00Z`, date: old, kind: 'wip', queued: true, stream: 's', text: 'nothing named here' },
        { id: 'bbbb', ts: new Date().toISOString(), date: new Date().toISOString().slice(0, 10), kind: 'wip', queued: true, stream: 's', repo: 'proj', text: 'rework MAESTRO-266' },
    ];
    writeFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    mkdirSync(join(container, 'proj'), { recursive: true });
    const git = (...a: string[]) => spawnSync('git', ['-C', join(container, 'proj'), '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'chore: init'); git('branch', 'feat/MAESTRO-266-x');
    return { vault, container };
}

test('--footer shows the oldest queued age and the rows that already have a built branch', () => {
    const { vault, container } = fixture();
    const r = spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_CONTAINER_ROOT: container, MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    assert.match(r.stdout, /^\*\*Queue:\*\* oldest 6d \(aaaa\); 1 of 2 already built \(branch exists\)$/m, r.stdout + r.stderr);
});
