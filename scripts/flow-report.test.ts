// Run: node --test scripts/flow-report.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./flow-report.ts', import.meta.url).pathname;
const env = { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '' };

function ledgerWith(rows: object[]): string {
    const vault = mkdtempSync(join(tmpdir(), 'flow-'));
    mkdirSync(join(vault, 'Projects', 'demo', 'Journal'), { recursive: true });
    writeFileSync(join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return vault;
}
const run = (...args: string[]) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env }); return { code: r.status, out: r.stdout, err: r.stderr }; };

const rows = [
    { id: 'aaaa', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', stream: 's', text: 'first' },
    { id: 'bbbb', ts: '2026-10-06T12:00:00Z', date: '2026-10-06', kind: 'done', closes: 'aaaa', text: 'done' },
    { id: 'cccc', ts: '2026-10-05T12:00:00Z', date: '2026-10-05', kind: 'wip', stream: 's', text: 'still open' },
];

test('prints the report from a ledger and writes nothing', () => {
    const vault = ledgerWith(rows);
    const r = run('--vault', vault, '--project', 'demo', '--now', '2026-10-07T12:00:00Z');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /throughput {2}1 done/);
    assert.match(r.out, /cccc {2}still open/);
});

test('--json prints the structured report', () => {
    const r = run('--vault', ledgerWith(rows), '--project', 'demo', '--now', '2026-10-07T12:00:00Z', '--json');
    const j = JSON.parse(r.out);
    assert.equal(j.done, 1);
    assert.equal(j.open[0].id, 'cccc');
});

test('refuses a missing root and a bad --days', () => {
    assert.equal(run('--project', 'demo').code, 2);
    assert.equal(run('--vault', ledgerWith(rows), '--project', 'demo', '--days', '0').code, 2);
});

test('refuses a negative --oldest', () => {
    assert.equal(run('--vault', ledgerWith(rows), '--project', 'demo', '--oldest', '-3').code, 2);
});
