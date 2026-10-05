// Run: node --test scripts/lib/status-page/streams.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prKeys, prStream } from './streams.ts';
import type { PrIdentity, StreamEvidence } from './streams.ts';

const KEY = '\\b[A-Z][A-Z0-9]+-\\d+\\b';
const pr = (number: number, title: string, over: Partial<PrIdentity> = {}): PrIdentity => ({ number, title, headRefName: `feat/x-${number}`, short: 'svc', nameWithOwner: 'org/svc', ...over });
const ev = (over: Partial<StreamEvidence> = {}): StreamEvidence => ({ items: [], ticketMap: {}, overrides: {}, repoStreams: {}, keyPattern: KEY, ...over });
const item = (id: string, text: string, stream?: string, refs: string[] = []) => ({ id, date: '2026-10-05', text, stream, refs });

test('a tracker key in the title maps to the stream of the board items that name it, whatever repo the PR is in', () => {
  const e = ev({ items: [item('a1', 'FAKE-7 stack merge-ups?', 'Alpha')], repoStreams: { svc: 'Beta' } });
  assert.equal(prStream(pr(1, 'fix: thing FAKE-7'), e), 'Alpha', 'the ledger wins over the repo map');
  assert.equal(prStream(pr(2, 'fix: other thing', { headRefName: 'feat/FAKE-7-x' }), e), 'Alpha', 'a key in the branch counts');
});

test('the key is matched as a whole token, case-insensitively, and inside a branch name', () => {
  const e = ev({ items: [item('a1', 'FAKE-77 is something else, as is XFAKE-7', 'Alpha'), item('a2', 'push fix/fake-7-remove-thing now', 'Beta')] });
  assert.equal(prStream(pr(1, 'fix: FAKE-7'), e), 'Beta');
});

test('ticket-map.json links a key to ask ids, and those asks carry the stream', () => {
  const e = ev({ items: [item('a1', 'unrelated words', 'Gamma')], ticketMap: { 'fake-9': ['a1'] } });
  assert.equal(prStream(pr(1, 'feat: FAKE-9'), e), 'Gamma');
});

test('a ledger row whose refs name the PR places it, with or without the gh:pr: prefix', () => {
  const e = ev({ items: [item('a1', 'no key here', 'Alpha', ['gh:pr:svc#5']), item('a2', 'no key here', 'Beta', ['org/svc#6'])] });
  assert.equal(prStream(pr(5, 'chore: x'), e), 'Alpha');
  assert.equal(prStream(pr(6, 'chore: y'), e), 'Beta');
});

test('the most-voted stream wins; items with no stream do not vote', () => {
  const e = ev({ items: [item('a1', 'FAKE-3', 'Alpha'), item('a2', 'FAKE-3', 'Beta'), item('a3', 'FAKE-3', 'Beta'), item('a4', 'FAKE-3', undefined)] });
  assert.equal(prStream(pr(1, 'feat: FAKE-3'), e), 'Beta');
});

test('with no ledger evidence: override, then repo map, then other', () => {
  const e = ev({ overrides: { 'svc#1': 'Gamma' }, repoStreams: { svc: 'Beta' } });
  assert.equal(prStream(pr(1, 'feat: FAKE-1'), e), 'Gamma');
  assert.equal(prStream(pr(2, 'feat: FAKE-2'), e), 'Beta');
  assert.equal(prStream(pr(3, 'feat: x', { short: 'zzz', nameWithOwner: 'org/zzz' }), e), 'other');
  assert.equal(prStream(pr(1, 'feat: x', { nameWithOwner: 'org/svc' }), ev({ overrides: { 'org/svc#1': 'Delta' } })), 'Delta');
});

test('CVE ids are not tickets', () => {
  assert.deepEqual(prKeys(pr(1, 'fix: CVE-2026-1234 in dep FAKE-4'), KEY), ['FAKE-4']);
});
