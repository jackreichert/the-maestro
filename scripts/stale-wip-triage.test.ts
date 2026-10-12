// Run: node --test scripts/stale-wip-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('./stale-wip-triage.ts', import.meta.url).pathname;

function ledgerWith(rows: object[]): { vault: string; file: string } {
    const vault = mkdtempSync(join(tmpdir(), 'stale-triage-'));
    mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
    const file = join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl');
    writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return { vault, file };
}
const run = (vault: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'p', '--today', '2026-10-12', ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } });

test('stale-wip-triage lists open in-flight rows as text and JSON, and writes nothing (MAESTRO-319)', () => {
    const { vault, file } = ledgerWith([
        { id: 'p1', ts: '2026-10-01T09:00:00Z', date: '2026-10-01', kind: 'wip', text: 'parent row' },
        { id: 'c1', ts: '2026-10-01T09:00:00Z', date: '2026-10-01', kind: 'wip', text: 'child', parent: 'p1' },
        { id: 'd1', ts: '2026-10-02T09:00:00Z', date: '2026-10-02', kind: 'done', closes: 'c1', text: 'child' },
        { id: 'w1', ts: '2026-10-03T09:00:00Z', date: '2026-10-03', kind: 'wip', text: 'lone row, acme/widgets#9' },
    ]);
    const before = readFileSync(file, 'utf8');
    const text = run(vault);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Open in-flight rows on 2026-10-12: 2 \(1 with hard evidence to close, 1 for a batch ask\)/);
    assert.match(text.stdout, /p1 .*CLOSE/);
    assert.match(text.stdout, /PRs: acme\/widgets#9/);
    const json = JSON.parse(run(vault, '--json').stdout) as { count: number; rows: { id: string; proposal: string }[] };
    assert.equal(json.count, 2);
    assert.deepEqual(json.rows.map((r) => [r.id, r.proposal]), [['p1', 'close'], ['w1', 'ask']]);
    assert.equal(readFileSync(file, 'utf8'), before, 'the ledger is byte-identical afterwards');
});

test('a bad day exits 2 with a message instead of listing nothing', () => {
    const { vault } = ledgerWith([]);
    const bad = spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'p', '--today', 'yesterday'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /YYYY-MM-DD/);
});
