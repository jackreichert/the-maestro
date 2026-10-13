import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOnePerTicket, keysIn, ticketKey, type OpenPr } from './pr-ticket-key.ts';

const RULES = { pattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', exemptHeads: ['release/*'], protectedBases: ['main', 'staging', 'develop'] };
const pr = (number: number, head: string, base: string, title = 't'): OpenPr => ({ number, title, headRefName: head, baseRefName: base, url: `https://github.com/o/r/pull/${number}` });
const mine = (over: Partial<{ branch: string; base: string; title: string; body: string }> = {}) => ({ branch: 'feat/ABC-12-thing', base: 'develop', title: 'Thing', body: 'Context', ...over });

test('key comes from the branch, else the title; matched as a whole token', () => {
  assert.equal(ticketKey('feat/abc-12-x', 'ZZZ-1', RULES.pattern), 'ABC-12');
  assert.equal(ticketKey('feature', 'fix ABC-9: thing', RULES.pattern), 'ABC-9');
  assert.deepEqual(keysIn('ABC-1 ABC-12', RULES.pattern), ['ABC-1', 'ABC-12']);
});

test('a second independent PR under the same key fails and names the other PR', () => {
  const v = checkOnePerTicket(mine(), [pr(7, 'feat/ABC-12-other', 'develop')], RULES);
  assert.equal(v.status, 'fail');
  assert.match(v.message, /ABC-12 already has an open PR: #7/);
  assert.match(v.message, /smaller ticket/);
});

test('the key is also found in the other PR title', () => {
  assert.equal(checkOnePerTicket(mine(), [pr(7, 'some-branch', 'develop', 'ABC-12 more')], RULES).status, 'fail');
});

test('a similar key is not the same key', () => {
  assert.equal(checkOnePerTicket(mine(), [pr(7, 'feat/ABC-123-x', 'develop'), pr(8, 'feat/ABC-1-x', 'develop')], RULES).status, 'pass');
});

test('a twin on the same head branch and another base passes', () => {
  assert.equal(checkOnePerTicket(mine({ base: 'staging' }), [pr(7, 'feat/ABC-12-thing', 'develop')], RULES).status, 'pass');
});

test('a twin on another branch passes only when it is on another protected base and the body links it', () => {
  const other = [pr(7, 'feat/ABC-12-develop', 'develop')];
  assert.equal(checkOnePerTicket(mine({ base: 'staging', body: 'Twin: #7' }), other, RULES).status, 'pass');
  assert.equal(checkOnePerTicket(mine({ base: 'staging', body: 'Twin: https://github.com/o/r/pull/7' }), other, RULES).status, 'pass');
  assert.equal(checkOnePerTicket(mine({ base: 'staging', body: 'no link' }), other, RULES).status, 'fail');
  assert.equal(checkOnePerTicket(mine({ base: 'staging', body: 'see #70' }), other, RULES).status, 'fail');
  assert.equal(checkOnePerTicket(mine({ base: 'develop', body: '#7' }), other, RULES).status, 'fail', 'same base is never a twin');
});

test('release PRs are exempt, whichever side they are on', () => {
  assert.equal(checkOnePerTicket(mine({ branch: 'release/ABC-12-v2', base: 'main' }), [pr(7, 'feat/ABC-12-x', 'develop')], RULES).status, 'pass');
  assert.equal(checkOnePerTicket(mine(), [pr(7, 'release/ABC-12', 'main')], RULES).status, 'pass');
});

test('a missing key passes with a note', () => {
  const v = checkOnePerTicket(mine({ branch: 'feature', title: 'no key' }), [pr(7, 'feat/ABC-12-x', 'develop')], RULES);
  assert.equal(v.status, 'pass');
  assert.match(v.message, /no ticket key/);
});

test('a stack under the same key passes with a warning that suggests a smaller ticket', () => {
  const v = checkOnePerTicket(mine({ base: 'feat/ABC-12-base' }), [pr(7, 'feat/ABC-12-base', 'develop')], RULES);
  assert.equal(v.status, 'warn');
  assert.match(v.message, /stacked under ABC-12 on #7/);
  assert.match(v.message, /own smaller ticket/);
});

test('a stack plus an independent rival still fails', () => {
  const open = [pr(7, 'feat/ABC-12-base', 'develop'), pr(8, 'feat/ABC-12-rival', 'develop')];
  assert.equal(checkOnePerTicket(mine({ base: 'feat/ABC-12-base' }), open, RULES).status, 'fail');
});

test('the PR being opened again (same head and base) is not its own rival', () => {
  assert.equal(checkOnePerTicket(mine(), [pr(7, 'feat/ABC-12-thing', 'develop')], RULES).status, 'pass');
});
