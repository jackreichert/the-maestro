// Run: node --test scripts/journal-rework.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

/** A throwaway ledger holding one in-flight item `aaaa` and one done item `dddd` (closed by `eeee`). */
function ledger(): string {
    const vault = mkdtempSync(join(tmpdir(), 'rework-'));
    const dir = join(vault, 'Projects', 'test-proj', 'Journal');
    mkdirSync(dir, { recursive: true });
    const rows = [
        { id: 'aaaa', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', stream: 's', text: 'first' },
        { id: 'dddd', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', stream: 's', text: 'second' },
        { id: 'eeee', ts: '2026-10-06T12:00:00Z', date: '2026-10-06', kind: 'done', closes: 'dddd', text: 'done' },
    ];
    writeFileSync(join(dir, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return vault;
}
const run = (vault: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj', ...MARK], {
        encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const rows = (vault: string): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('log <id> --kind rework writes a rework row naming the item, even a done one', () => {
    const vault = ledger();
    const r = run(vault, 'log', 'dddd', 'fixed the tests by hand', '--kind', 'rework');
    assert.equal(r.code, 0, r.err);
    const row = rows(vault).find((x) => x.kind === 'rework');
    assert.equal(row?.reworks, 'dddd');
    assert.match(String(row?.text), /fixed the tests by hand/);
});

test('a rework row is an event, not an open item', () => {
    const vault = ledger();
    assert.equal(run(vault, 'log', 'aaaa', '--kind', 'rework').code, 0);
    const board = run(vault, 'status').out;
    assert.equal(board.includes('rework'), false, board);
});

test('an unknown id is refused and writes nothing', () => {
    const vault = ledger();
    const r = run(vault, 'log', 'zzzz', 'x', '--kind', 'rework');
    assert.equal(r.code, 1);
    assert.match(r.err, /needs the id of an item/);
    assert.equal(rows(vault).some((x) => x.kind === 'rework'), false);
});
