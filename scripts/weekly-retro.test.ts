// Run: node --test scripts/weekly-retro.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./weekly-retro.ts', import.meta.url).pathname;
const env = { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '' };

function ledgerWith(rows: object[]): string {
    const vault = mkdtempSync(join(tmpdir(), 'retro-'));
    mkdirSync(join(vault, 'Projects', 'demo', 'Journal'), { recursive: true });
    writeFileSync(join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return vault;
}
const run = (...args: string[]) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const rows = [
    { id: 'aaaa', ts: '2026-09-20T10:00:00Z', date: '2026-09-20', kind: 'wip', stream: 's', text: 'long open' },
    { id: 'bbbb', ts: '2026-10-02T10:00:00Z', date: '2026-10-02', kind: 'note', stream: 's', text: 'Retro experiment: try x' },
];

test('prints the draft from a ledger, as text and as json', () => {
    const vault = ledgerWith(rows);
    const text = run('--vault', vault, '--project', 'demo', '--now', '2026-10-09T12:00:00Z');
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /aaaa {2}long open/);
    assert.match(text.out, /try x/);
    const json = JSON.parse(run('--vault', vault, '--project', 'demo', '--now', '2026-10-09T12:00:00Z', '--json').out);
    assert.equal(json.stale[0].id, 'aaaa');
    assert.equal(json.experiment.verdict, null);
});

test('refuses a missing root and a bad --days', () => {
    assert.equal(run('--project', 'demo').code, 2);
    assert.equal(run('--vault', ledgerWith(rows), '--project', 'demo', '--days', '0').code, 2);
});

test('lists the library misses logged in the window and how many were answered', () => {
    const miss = (id: string, ts: string) => ({ id, ts, date: ts.slice(0, 10), kind: 'miss', text: `question ${id}`, source: 'find', topic: 'orchard index' });
    const vault = ledgerWith([
        ...rows,
        miss('m1', '2026-10-06T10:00:00Z'), miss('m2', '2026-10-06T11:00:00Z'), miss('m3', '2026-10-07T10:00:00Z'), miss('m0', '2026-09-01T10:00:00Z'),
        { id: 'c1', ts: '2026-10-07T12:00:00Z', date: '2026-10-07', kind: 'curated', closes: 'm1', text: 'curated m1', page: 'Projects/demo/Knowledge/orchard.md', pageSha: 'a'.repeat(64) },
        { id: 'c2', ts: '2026-10-07T12:01:00Z', date: '2026-10-07', kind: 'curated', closes: 'm2', text: 'curated m2', rejected: 'not a project question' },
    ]);
    const args = ['--vault', vault, '--project', 'demo', '--now', '2026-10-09T12:00:00Z'];
    assert.match(run(...args).out, /library misses {3}3 logged, 1 answered with a page, 1 out of scope, 1 open/);
    assert.deepEqual(JSON.parse(run(...args, '--json').out).misses, { logged: 3, answered: 1, outOfScope: 1, open: 1 });
});
