// Run: node --test scripts/queue-report.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { writeStub } from './lib/stub-bin.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./queue-report.ts', import.meta.url).pathname;

function ledgerWith(rows: object[]): { vault: string; ledger: string } {
    const vault = mkdtempSync(join(tmpdir(), 'qr-'));
    mkdirSync(join(vault, 'Projects', 'demo', 'Journal'), { recursive: true });
    const ledger = join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl');
    writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { vault, ledger };
}

/** A fake gh: PR 483 is MERGED, anything else OPEN. */
function fakeGh(): string {
    const f = join(mkdtempSync(join(tmpdir(), 'qr-gh-')), 'gh');
    writeStub(f, `#!/bin/sh\ncase "$3" in 483) echo MERGED;; *) echo OPEN;; esac\n`);
    return f;
}

test('reports in-flight and queued rows naming a merged PR, closes nothing, and prints the close command', () => {
    const { vault, ledger } = ledgerWith([
        { id: 'aaaa', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', text: 'follow-ups for acme/svc#483' },
        { id: 'bbbb', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', queued: true, text: 'watch acme/svc#9' },
        { id: 'cccc', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', text: 'no pr named' },
    ]);
    const before = readFileSync(ledger, 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'demo'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_GH_BIN: fakeGh() } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Open rows naming a merged PR \(1\)/);
    assert.match(r.stdout, /aaaa {2}follow-ups for acme\/svc#483/);
    assert.match(r.stdout, /close if you agree: journal\.ts done aaaa/);
    assert.equal(r.stdout.includes('bbbb'), false, 'an open PR is not reported');
    assert.equal(readFileSync(ledger, 'utf8'), before, 'the ledger is untouched');
});
