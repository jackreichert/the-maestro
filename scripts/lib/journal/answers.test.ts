// Run: node --test scripts/lib/journal/answers.test.ts
import { test } from 'node:test';
import { ASK_TEMPLATE } from '../ask-template-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { recordAnswer } from './answers.ts';
import { verifyLedger } from './verify.ts';

const DAY = '2026-10-12';
const seed = (): LedgerRow[] => [
  { id: 'ab12', kind: 'question', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'ship it?', stream: 'Alpha' },
  { id: 'cd34', kind: 'question', ts: `${DAY}T09:01:00Z`, date: DAY, text: 'old one' },
  { id: 'ef56', kind: 'resolved', closes: 'cd34', ts: `${DAY}T09:02:00Z`, date: DAY, text: 'done' },
];
const store = (rows: LedgerRow[]) => ({
  readLedger: () => rows,
  append: <E>(e: E): E => { rows.push(e as LedgerRow); return e; },
  newId: () => `n${rows.length}`,
});
const record = (rows: LedgerRow[], over: Partial<Parameters<typeof recordAnswer>[1]> = {}) =>
  recordAnswer(store(rows), { kind: 'answer', ask: 'ab12', text: 'yes', source: 'page', usage: { model: 'm', used: ['tool:t'] }, now: () => `${DAY}T10:00:00Z`, today: () => DAY, ...over });

test('an answer is one non-item row about the ask, and the ask stays open and carries it', () => {
  const rows = seed();
  assert.equal(record(rows), 'written');
  assert.deepEqual(rows[3], { id: 'n3', ts: `${DAY}T10:00:00Z`, date: DAY, kind: 'answer', of: 'ab12', source: 'page', text: 'yes', stream: 'Alpha', model: 'm', used: ['tool:t'] });
  const items = fold(rows, null).items;
  assert.deepEqual(items.map((i) => i.id), ['ab12', 'cd34'], 'the answer row is not an item');
  assert.equal(items[0]?.answer, 'yes');
  assert.equal(items[0]?.closedBy, null);
});

test('the same answer twice is one row; a changed answer is a new row and the latest wins', () => {
  const rows = seed();
  record(rows); assert.equal(record(rows, { text: '  yes ' }), 'same');
  assert.equal(rows.length, 4);
  assert.equal(record(rows, { text: 'no, wait' }), 'written');
  assert.equal(fold(rows, null).items[0]?.answer, 'no, wait');
});

test('a closed, unknown or ambiguous ask takes nothing', () => {
  const rows = seed();
  rows.push({ id: 'ab99', kind: 'question', ts: `${DAY}T09:03:00Z`, date: DAY, text: 'another' });
  assert.equal(record(rows, { ask: 'cd34' }), 'no-ask');
  assert.equal(record(rows, { ask: 'zzzz' }), 'no-ask');
  assert.equal(record(rows, { ask: 'ab' }), 'no-ask', 'a prefix that matches two asks names neither');
  assert.equal(record(rows, { ask: 'ab1' }), 'written', 'a unique prefix is enough');
  assert.equal(rows.length, 5);
});

test('a discuss row records the topic apart from the answer, and resolving the ask drops both from it', () => {
  const rows = seed();
  record(rows, { kind: 'discuss', text: '' });
  record(rows);
  const open = fold(rows, null).items[0];
  assert.equal(open?.discussing, '');
  assert.equal(open?.answer, 'yes');
  rows.push({ id: 'zz01', kind: 'resolved', closes: 'ab12', ts: `${DAY}T11:00:00Z`, date: DAY, text: 'ok' });
  const closed = fold(rows, null).items[0];
  assert.equal(closed?.answer, undefined);
  assert.equal(closed?.discussing, undefined);
});

test('verify flags an answer whose ask does not exist', () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ans-')), 'ledger.jsonl');
  const lines = [{ id: 'ab12', kind: 'question' }, { id: 'n1', kind: 'answer', of: 'ab12', text: 'x' }, { id: 'n2', kind: 'answer', of: 'gone', text: 'y' }];
  writeFileSync(ledgerPath, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { problems } = verifyLedger({ ledgerPath, approvals: new Set(), approvableKinds: new Set(), autocommit: false, dryRun: false, vault: '' });
  assert.deepEqual(problems.map((p) => p.problem), ['of refers to gone, which does not exist']);
});

test('journal.ts answer and discuss: write once, refuse a closed ask, show the answer in status --json', () => {
  const vault = mkdtempSync(join(tmpdir(), 'ans-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'ans-home-'));
  const journal = (...args: string[]) => spawnSync(process.execPath, [new URL('../../journal.ts', import.meta.url).pathname, ...args, '--vault', vault, '--project', 'p', '--allow-unmarked'], { encoding: 'utf8', env: { ...process.env, HOME: home, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' } });
  const ask = journal('ask', 'ship it?', '--kind', 'question', '--searched', 'test fixture', ...ASK_TEMPLATE);
  assert.equal(ask.status, 0, ask.stderr);
  const id = ask.stdout.trim().split(/\s+/)[1] as string;
  const first = journal('answer', id, '--text', 'yes', '--source', 'page');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^answer {2}/);
  assert.match(journal('answer', id, '--text', 'yes').stdout, /^already recorded/);
  assert.equal(journal('answer', id).status, 1, 'an answer needs text');
  assert.equal(journal('discuss', id).status, 0);
  const status = JSON.parse(journal('status', '--json').stdout) as { awaiting: { id: string; answer?: string; discussing?: string }[] };
  assert.deepEqual(status.awaiting.map((a) => [a.id, a.answer, a.discussing]), [[id, 'yes', '']]);
  assert.equal(journal('resolve', id, '--answer', 'done').status, 0);
  const late = journal('answer', id, '--text', 'too late');
  assert.equal(late.status, 1);
  assert.match(late.stderr, /No open ask/);
});
