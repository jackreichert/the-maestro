// Run: node --test scripts/journal-footer-github.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;

/** Runs `status --footer` with an event dir whose gh-budget.json holds `state` (none when null). */
function footer(state: object | null): string {
    const root = mkdtempSync(join(tmpdir(), 'fg-'));
    const vault = join(root, 'vault');
    const events = join(vault, 'Events');
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Journal'), { recursive: true });
    mkdirSync(events, { recursive: true });
    if (state) writeFileSync(join(events, 'gh-budget.json'), JSON.stringify(state));
    const r = spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York', VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: events },
    });
    return r.stdout + r.stderr;
}

test('--footer says when GitHub is limited, and says nothing once the block has passed or when there is none', () => {
    const future = Date.now() + 40 * 60_000;
    assert.match(footer({ blockedUntil: future, reason: 'GitHub reported a rate limit' }), /^\*\*GitHub:\*\* limited until \d{1,2}:\d{2} [ap]m E[SD]T \(GitHub reported a rate limit\)$/m);
    assert.doesNotMatch(footer({ blockedUntil: Date.now() - 1000 }), /GitHub:/);
    assert.doesNotMatch(footer(null), /GitHub:/);
});
