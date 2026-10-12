// Run: node --test scripts/journal-guidance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guidanceLines, tokenCount, readGuidance, GUIDANCE_FILE } from './lib/journal/guidance.ts';
import type { LedgerItem, LedgerRow } from './lib/ledger-core.ts';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const item = (o: Partial<LedgerItem>): LedgerItem => ({ kind: 'wip', closedBy: null, state: 'wip', date: '2026-10-12', ...o } as LedgerItem);

test('tokenCount reads k and M marks and treats unmeasured as zero', () => {
    assert.equal(tokenCount('42k'), 42000);
    assert.equal(tokenCount('1.5M'), 1500000);
    assert.equal(tokenCount('5000'), 5000);
    for (const v of ['unmeasured', 'n/a', undefined, '']) assert.equal(tokenCount(v), 0);
});

test('an item in flight past the floor is stalled; a fresh one is not', () => {
    const old = item({ id: 'old1', text: 'long job', ts: '2026-10-09T12:00:00Z', stream: 's' });
    const fresh = item({ id: 'new1', text: 'new job', ts: '2026-10-12T10:00:00Z', stream: 's' });
    const out = guidanceLines([old, fresh], [], [old, fresh], [], '2026-10-12', NOW).join('\n');
    assert.match(out, /Stalled \(1\): old1 long job, 3d in flight/);
    assert.doesNotMatch(out, /new1 new job, /);
});

test('"usual" comes from finished items: a long-running history raises the bar', () => {
    const done = (n: number) => item({ id: `d${n}`, state: 'done', ts: '2026-10-01T00:00:00Z', closedBy: { ts: '2026-10-04T00:00:00Z', kind: 'done' } as LedgerRow });
    const mid = item({ id: 'mid1', text: 'two days', ts: '2026-10-10T12:00:00Z' });
    assert.match(guidanceLines([mid], [], [mid], [], '2026-10-12', NOW).join('\n'), /Stalled/);
    assert.doesNotMatch(guidanceLines([mid, done(1), done(2), done(3)], [], [mid], [], '2026-10-12', NOW).join('\n'), /Stalled/);
});

test('a rework row on a finished item is reported today', () => {
    const done = item({ id: 'rwk1', text: 'edited after use', state: 'done', ts: '2026-10-10T11:00:00Z', closedBy: { kind: 'done', date: '2026-10-10', ts: '2026-10-10T12:00:00Z' } as LedgerRow });
    const out = guidanceLines([done], [{ kind: 'rework', reworks: 'rwk1', date: '2026-10-12' }], [], [], '2026-10-12', NOW).join('\n');
    assert.match(out, /Reworked today \(1\): rwk1 edited after use/);
    assert.doesNotMatch(guidanceLines([done], [{ kind: 'rework', reworks: 'rwk1', date: '2026-10-11' }], [], [], '2026-10-12', NOW).join('\n'), /Reworked/);
});

test('a rework row on an open item is reported today, even when young', () => {
    const a = item({ id: 'rwk2', text: 'edited by hand', ts: '2026-10-12T11:00:00Z' });
    const out = guidanceLines([a], [{ kind: 'rework', reworks: 'rwk2', date: '2026-10-12' }, { kind: 'rework', reworks: 'rwk2', date: '2026-10-12' }], [a], [], '2026-10-12', NOW).join('\n');
    assert.match(out, /Reworked today \(1\): rwk2 edited by hand/);
});

test('cost names the biggest item and the biggest stream', () => {
    const a = item({ id: 'a1', text: 'big', tokens: '300k', stream: 'alpha', ts: '2026-10-12T09:00:00Z' });
    const b = item({ id: 'b1', text: 'mid', tokens: '100k', stream: 'beta', ts: '2026-10-12T09:00:00Z' });
    const c = item({ id: 'c1', text: 'mid2', tokens: '250k', stream: 'beta', ts: '2026-10-12T09:00:00Z' });
    const out = guidanceLines([a, b, c], [], [a], [], '2026-10-12', NOW).join('\n');
    assert.match(out, /Cost most: a1 big \(300k tokens\); stream beta 350k in all/);
});

test('cost counts tokens recorded on done, and items finished today that started earlier', () => {
    const closed = item({ id: 'big1', text: 'big job', tokens: 'unmeasured', stream: 'alpha', state: 'done', date: '2026-10-11', ts: '2026-10-11T09:00:00Z', closedBy: { kind: 'done', date: '2026-10-12', ts: '2026-10-12T10:00:00Z', tokens: '500k' } as LedgerRow });
    const open = item({ id: 'sml1', text: 'small job', tokens: '10k', stream: 'beta', ts: '2026-10-12T09:00:00Z' });
    const out = guidanceLines([closed, open], [], [open], [], '2026-10-12', NOW).join('\n');
    assert.match(out, /Cost most: big1 big job \(500k tokens\); stream alpha 500k in all/);
    const old = item({ ...closed, id: 'old1', closedBy: { kind: 'done', date: '2026-10-10', ts: '2026-10-10T10:00:00Z', tokens: '900k' } as LedgerRow });
    assert.match(guidanceLines([old, open], [], [open], [], '2026-10-12', NOW).join('\n'), /Cost most: sml1/);
});

test('do first prefers a blocked item, then the first in flight; empty ledger says nothing', () => {
    const a = item({ id: 'f1', text: 'running', ts: '2026-10-12T09:00:00Z' });
    const b = item({ id: 'b1', text: 'stuck', kind: 'blocked', ts: '2026-10-12T09:00:00Z' });
    assert.match(guidanceLines([a, b], [], [a], [b], '2026-10-12', NOW).join('\n'), /Do first: b1 stuck \(blocked/);
    assert.match(guidanceLines([a], [], [a], [], '2026-10-12', NOW).join('\n'), /Do first: f1 running$/m);
    assert.deepEqual(guidanceLines([], [], [], [], '2026-10-12', NOW), []);
});

test('do first skips items on hold and items waiting on Jack, and prefers today\'s priorities', () => {
    const hold = item({ id: 'h1', text: 'monitor, on hold until spring', kind: 'blocked', ts: '2026-10-12T09:00:00Z' });
    const ask = item({ id: 'k1', text: 'needs a call', kind: 'blocked', ts: '2026-10-12T09:00:00Z' });
    const real = item({ id: 'r1', text: 'fix the build', kind: 'blocked', stream: 'alpha', ts: '2026-10-12T09:00:00Z' });
    const run = item({ id: 'f1', text: 'ship docs', stream: 'beta', ts: '2026-10-12T09:00:00Z' });
    const all = [hold, ask, real, run];
    assert.match(guidanceLines(all, [], [run], [hold, ask, real], '2026-10-12', NOW, { awaiting: [ask] }).join('\n'), /Do first: r1 fix the build \(blocked/);
    assert.match(guidanceLines(all, [], [run], [hold, ask], '2026-10-12', NOW, { awaiting: [ask] }).join('\n'), /Do first: f1 ship docs$/m);
    assert.match(guidanceLines(all, [], [run], [hold, ask, real], '2026-10-12', NOW, { awaiting: [ask], priorities: [{ text: 'Docs', stream: 'beta' }] }).join('\n'), /Do first: f1 ship docs$/m);
    assert.match(guidanceLines(all, [], [run], [hold, ask, real], '2026-10-12', NOW, { awaiting: [ask], priorities: [{ text: 'unrelated thing' }] }).join('\n'), /Do first: r1/);
});

test('do first obeys the structured gate: a waiting gate is skipped, a cleared one goes first', () => {
    const waiting = item({ id: 'g1', text: 'release window', kind: 'blocked', gate: 'date:2026-12-01', ts: '2026-10-12T09:00:00Z' });
    const clear = item({ id: 'g2', text: 'ready now', kind: 'blocked', gate: 'date:2026-10-01', ts: '2026-10-12T09:00:00Z' });
    const run = item({ id: 'f1', text: 'ship docs', ts: '2026-10-12T09:00:00Z' });
    const gates = new Map<string, 'cleared' | 'waiting' | 'unknown'>([['g1', 'waiting'], ['g2', 'cleared']]);
    assert.match(guidanceLines([waiting, run], [], [run], [waiting], '2026-10-12', NOW, { gates }).join('\n'), /Do first: f1 ship docs$/m);
    assert.match(guidanceLines([waiting, clear, run], [], [run], [waiting, clear], '2026-10-12', NOW, { gates, priorities: [{ text: 'ship docs' }] }).join('\n'), /Do first: g2 ready now \(blocked/);
    assert.doesNotMatch(guidanceLines([waiting], [], [], [waiting], '2026-10-12', NOW, {}).join('\n'), /Do first/);
});

test('the note stays within a header and four lines', () => {
    const a = item({ id: 'a1', text: 'x', tokens: '1k', ts: '2026-10-01T00:00:00Z' });
    assert.ok(guidanceLines([a], [], [a], [], '2026-10-12', NOW).length <= 5);
});

test('readGuidance skips a missing or stale note', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guid-'));
    assert.deepEqual(readGuidance(dir, '2026-10-12'), []);
    writeFileSync(join(dir, GUIDANCE_FILE), 'Guidance from the 2026-10-01 roll:\n  Do first: a\n');
    assert.deepEqual(readGuidance(dir, '2026-10-12'), []);
    assert.equal(readGuidance(dir, '2026-10-02').length, 2);
});

function vaultWith(rows: object[]): { vault: string; dir: string } {
    const vault = mkdtempSync(join(tmpdir(), 'guid-vault-'));
    const dir = join(vault, 'Projects', 'test-proj', 'Journal');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { vault, dir };
}
const run = (vault: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj', '--model', 'Test Model', '--used', 'tool:journal.ts'], {
    encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_STATUS_DIR: join(vault, 'status') },
});

test('roll writes GUIDANCE.md, prints it, and prime shows it next session', () => {
    const { vault, dir } = vaultWith([
        { id: 'aaaa', ts: '2026-10-08T10:00:00Z', date: '2026-10-08', kind: 'wip', stream: 's', text: 'ancient job', tokens: '90k' },
        { id: 'bbbb', ts: '2026-10-12T10:00:00Z', date: '2026-10-12', kind: 'wip', stream: 's', text: 'today job' },
    ]);
    const roll = run(vault, 'roll', '--date', '2026-10-12', '--fast', '--allow-unmarked');
    assert.equal(roll.status, 0, roll.stderr);
    assert.match(roll.stdout, /Guidance from the 2026-10-12 roll:/);
    assert.match(roll.stdout, /Stalled \(1\): aaaa ancient job/);
    const saved = readFileSync(join(dir, GUIDANCE_FILE), 'utf8');
    assert.match(saved, /Do first: aaaa ancient job/);
    const prime = run(vault, 'prime', '--no-update-check', '--allow-unmarked', '--date', '2026-10-12');
    assert.match(prime.stdout, /Guidance from the 2026-10-12 roll:/);
});

test('roll --dry-run prints the guidance and writes no file', () => {
    const { vault, dir } = vaultWith([{ id: 'aaaa', ts: '2026-10-12T10:00:00Z', date: '2026-10-12', kind: 'wip', stream: 's', text: 'job' }]);
    const roll = run(vault, 'roll', '--date', '2026-10-12', '--fast', '--dry-run', '--allow-unmarked');
    assert.match(roll.stdout, /Do first: aaaa job/);
    assert.equal(existsSync(join(dir, GUIDANCE_FILE)), false);
});
