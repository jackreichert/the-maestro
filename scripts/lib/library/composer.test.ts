// Run: node --test scripts/lib/library/composer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPOSER_ITEM, composerLease, curatedProblems, pendingLearned } from './composer.ts';
import { verifyLedger } from '../journal/verify.ts';
import type { LedgerRow } from '../ledger-core.ts';

const SHA = 'a'.repeat(64);
const PAGE = 'Projects/fake-repo/Knowledge/fake-page.md';
const learned = (id: string): LedgerRow => ({ id, ts: '2026-10-10T10:00:00.000Z', kind: 'learned', text: 'The fake page count is the page length.', learnedKind: 'how-it-works', appliesTo: 'fake-repo:fake-api', evidence: 'spec:1', verifiedAt: '342b177', confidence: 'observed' });
const curated = (id: string, closes: string, over: LedgerRow = {}): LedgerRow => ({ id, ts: '2026-10-10T10:05:00.000Z', kind: 'curated', closes, text: `curated ${closes}`, page: PAGE, pageSha: SHA, window: 'cmp-test', ...over });

function problemsOf(rows: LedgerRow[]): string[] {
  const vault = mkdtempSync(join(tmpdir(), 'composer-'));
  const ledgerPath = join(vault, 'ledger.jsonl');
  writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return verifyLedger({ ledgerPath, approvals: new Set(), approvableKinds: new Set(), autocommit: false, dryRun: false, vault }).problems.map((p) => p.problem);
}

test('a learned row closed by a curated row is no longer pending; an open one still is, in order', () => {
  const rows = [learned('aaaa'), learned('bbbb'), learned('cccc'), curated('dddd', 'bbbb')];
  assert.deepEqual(pendingLearned(rows).map((r) => r.id), ['aaaa', 'cccc']);
});

test('a note closing a learned row does not count as composing it, and verify still flags it', () => {
  const rows = [learned('aaaa'), { id: 'bbbb', ts: '2026-10-10T10:05:00.000Z', kind: 'note', closes: 'aaaa', text: 'x' }];
  assert.deepEqual(pendingLearned(rows).map((r) => r.id), ['aaaa']);
  assert.deepEqual(problemsOf(rows), ['closes aaaa, a learned row; only a composer pass handles a learned row']);
});

test('verify passes a well-formed curated row, page or rejected', () => {
  assert.deepEqual(problemsOf([learned('aaaa'), learned('bbbb'), curated('cccc', 'aaaa'), curated('dddd', 'bbbb', { page: undefined, pageSha: undefined, rejected: 'a status, not a fact' })]), []);
});

test('verify flags a curated row with both or neither of page and rejected', () => {
  const both = problemsOf([learned('aaaa'), curated('bbbb', 'aaaa', { rejected: 'why' })]);
  const neither = problemsOf([learned('aaaa'), curated('bbbb', 'aaaa', { page: undefined, pageSha: undefined })]);
  assert.ok(both.some((p) => /exactly one of page and rejected/.test(p)));
  assert.ok(neither.some((p) => /exactly one of page and rejected/.test(p)));
});

test('verify flags a curated row that closes nothing learned, has a bad page path or no pageSha, or carries an unknown field', () => {
  assert.ok(curatedProblems(curated('x', 'zzzz'), new Set(['aaaa'])).some((p) => /closes must name a learned row/.test(p)));
  assert.ok(curatedProblems(curated('x', 'aaaa', { page: 'Projects/fake-repo/Knowledge/../../x.md' }), new Set(['aaaa'])).some((p) => /page path/.test(p)));
  assert.ok(curatedProblems(curated('x', 'aaaa', { pageSha: undefined }), new Set(['aaaa'])).some((p) => /pageSha/.test(p)));
  assert.ok(curatedProblems(curated('x', 'aaaa', { surprise: 'hi' }), new Set(['aaaa'])).some((p) => /never sets/.test(p)));
});

test('a secret shape in rejected is flagged without echoing it, as is a long or multi-line one', () => {
  const secret = ['pass', 'word=hunter2'].join('');
  const base = { page: undefined, pageSha: undefined };
  const p = problemsOf([learned('aaaa'), curated('bbbb', 'aaaa', { ...base, rejected: secret })]);
  assert.ok(p.some((m) => /scanner/.test(m)));
  assert.ok(p.every((m) => !m.includes('hunter2')));
  assert.ok(curatedProblems(curated('x', 'aaaa', { ...base, rejected: 'x'.repeat(301) }), new Set(['aaaa'])).some((m) => /over 300/.test(m)));
  assert.ok(curatedProblems(curated('x', 'aaaa', { ...base, rejected: 'one\ntwo' }), new Set(['aaaa'])).some((m) => /one plain line/.test(m)));
});

const lease = (ts: string, window: string, ttl = 30): LedgerRow => ({ ts, kind: 'lease', leases: COMPOSER_ITEM, window, ttl, text: `lease ${COMPOSER_ITEM}` });

test('lastPassAt is the newest lease row on the composer item; the lease is live only inside its ttl', () => {
  const other: LedgerRow = { ts: '2026-10-10T12:00:00.000Z', kind: 'lease', leases: 'other-item', window: 'w1', ttl: 30, text: 'x' };
  const rows = [lease('2026-10-10T09:00:00.000Z', 'cmp-a'), lease('2026-10-10T10:00:00.000Z', 'cmp-b'), other];
  const at = (iso: string) => composerLease(rows, Date.parse(iso));
  assert.equal(at('2026-10-10T10:10:00.000Z').lastPassAt, '2026-10-10T10:00:00.000Z');
  assert.equal(at('2026-10-10T10:10:00.000Z').live?.holder, 'cmp-b');
  assert.equal(at('2026-10-10T11:00:00.000Z').live, undefined, 'lapsed');
  assert.equal(at('2026-10-10T11:00:00.000Z').lastPassAt, '2026-10-10T10:00:00.000Z', 'a lapsed pass still dates the last one');
  assert.deepEqual(composerLease([], 0), {});
});
