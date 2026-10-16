// Run: node --test scripts/lib/teammate/others-actions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { actionsPath, ignorePr, ignoreState, isIgnored, isPrKey, isSha, readIgnored, readRequests, requestReview, unignorePr } from './others-actions.ts';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const K = 'acme/app#7';
const file = (): string => actionsPath(mkdtempSync(join(tmpdir(), 'others-actions-')), 'p');

test('ignore pins the head; the same ignore twice writes one row', () => {
  const f = file();
  assert.equal(ignorePr(f, K, H1), true);
  assert.equal(ignorePr(f, K, H1), false);
  assert.equal(readFileSync(f, 'utf8').trim().split('\n').length, 1);
  assert.equal(readIgnored(f).get(K), H1);
});

test('a new head un-ignores in effect: the PR reads "new-commits", and ignoring again pins the new head', () => {
  const f = file();
  ignorePr(f, K, H1);
  const m = readIgnored(f);
  assert.equal(ignoreState(m, K, H1), 'ignored');
  assert.equal(ignoreState(m, K, H2), 'new-commits');
  assert.equal(isIgnored(m, K, H2), false);
  assert.equal(ignoreState(m, 'acme/app#8', H1), null);
  ignorePr(f, K, H2);
  assert.equal(ignoreState(readIgnored(f), K, H2), 'ignored');
});

test('unignore removes the ignore and is idempotent; a later ignore puts it back', () => {
  const f = file();
  assert.equal(unignorePr(f, K), false, 'nothing to remove writes nothing');
  ignorePr(f, K, H1);
  assert.equal(unignorePr(f, K), true);
  assert.equal(unignorePr(f, K), false);
  assert.equal(readIgnored(f).has(K), false);
  ignorePr(f, K, H1);
  assert.equal(readIgnored(f).get(K), H1);
});

test('review requests are pinned to a head, idempotent per head, and the latest wins', () => {
  const f = file();
  assert.equal(requestReview(f, K, H1), true);
  assert.equal(requestReview(f, K, H1), false);
  assert.equal(requestReview(f, K, H2), true);
  assert.equal(readRequests(f).get(K), H2);
});

test('a missing file reads as empty; a damaged or malformed row is skipped, not fatal', () => {
  const f = file();
  assert.equal(readIgnored(f).size, 0);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, ['not json', JSON.stringify({ op: 'ignore', key: 'bad key', head: H1, ts: 't' }), JSON.stringify({ op: 'ignore', key: K, head: 'short', ts: 't' }), JSON.stringify({ op: 'ignore', key: K, head: H1, ts: 't' }), ''].join('\n'));
  assert.deepEqual([...readIgnored(f)], [[K, H1]]);
});

test('writes refuse a malformed key or head, and the guards agree', () => {
  const f = file();
  assert.throws(() => ignorePr(f, 'nope', H1));
  assert.throws(() => ignorePr(f, K, 'abc'));
  assert.throws(() => requestReview(f, K, 'abc'));
  assert.throws(() => unignorePr(f, 'no-slash#1'));
  assert.equal(isPrKey(K), true);
  assert.equal(isPrKey('acme/app#0'), false);
  assert.equal(isSha('A'.repeat(40)), false);
});
