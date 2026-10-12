// Run: node --test scripts/queue-report.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT = new URL('./queue-report.ts', import.meta.url).pathname;

function ledgerWith(rows: object[]): { vault: string; ledger: string } {
    const vault = mkdtempSync(join(tmpdir(), 'qr-'));
    mkdirSync(join(vault, 'Projects', 'demo', 'Journal'), { recursive: true });
    const ledger = join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl');
    writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { vault, ledger };
}

/**
 * A fake gh: PR 483 is MERGED, anything else OPEN. It is node itself (MAESTRO_GH_BIN) steered by a preloaded module, not a script written for the
 * test: the first run of a freshly written executable can stall past the report's per-lookup timeout under load (a macOS provenance scan).
 * NODE_OPTIONS reaches the report too, so the module acts only when launched as `gh pr view <n>`.
 */
function fakeGhEnv(): NodeJS.ProcessEnv {
    const preload = join(mkdtempSync(join(tmpdir(), 'qr-gh-')), 'gh.mjs');
    writeFileSync(preload, `if (process.argv[2] === 'view') { console.log(process.argv[3] === '483' ? 'MERGED' : 'OPEN'); process.exit(0); }\n`);
    return { MAESTRO_GH_BIN: process.execPath, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` };
}

test('reports in-flight and queued rows naming a merged PR, closes nothing, and prints the close command', () => {
    const { vault, ledger } = ledgerWith([
        { id: 'aaaa', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', text: 'follow-ups for acme/svc#483' },
        { id: 'bbbb', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', queued: true, text: 'watch acme/svc#9' },
        { id: 'cccc', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', text: 'no pr named' },
    ]);
    const before = readFileSync(ledger, 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'demo'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', ...fakeGhEnv() } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Open rows naming a merged PR \(1\)/);
    assert.match(r.stdout, /aaaa {2}follow-ups for acme\/svc#483/);
    assert.match(r.stdout, /close if you agree: journal\.ts done aaaa/);
    assert.equal(r.stdout.includes('bbbb'), false, 'an open PR is not reported');
    assert.equal(readFileSync(ledger, 'utf8'), before, 'the ledger is untouched');
});
