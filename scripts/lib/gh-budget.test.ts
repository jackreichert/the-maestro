import './hermetic-config.ts';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendCall, applyFailure, applyProbe, blockedUntil, callsPerHour, classifyGh, FLOOR, isRateLimitError, limitedText, MAX_BACKOFF_MS, needsProbe, PROBE_MS, readCalls, readState, writeState } from './gh-budget.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'gh-budget-'));
const T0 = Date.parse('2026-10-16T01:00:00Z');
const RESET = Date.parse('2026-10-16T02:23:15Z');

test('classifyGh: pr and graphql calls spend GraphQL, api paths and runs spend REST, the rate-limit read and local config are free', () => {
  assert.equal(classifyGh(['pr', 'view', '12', '--repo', 'o/r']), 'graphql');
  assert.equal(classifyGh(['pr', 'checks', '12']), 'graphql');
  assert.equal(classifyGh(['api', 'graphql', '-f', 'query=x']), 'graphql');
  assert.equal(classifyGh(['api', 'user', '--jq', '.login']), 'rest');
  assert.equal(classifyGh(['api', '-X', 'POST', 'repos/o/r/issues']), 'rest');
  assert.equal(classifyGh(['run', 'view', '1']), 'rest');
  assert.equal(classifyGh(['api', 'rate_limit']), 'free');
  assert.equal(classifyGh(['auth', 'status']), 'free');
  assert.equal(classifyGh([]), 'free');
});

test('isRateLimitError matches the primary, secondary and abuse wordings and nothing else', () => {
  assert.ok(isRateLimitError('GraphQL: API rate limit already exceeded for user ID 1. (graphql)'));
  assert.ok(isRateLimitError('You have exceeded a secondary rate limit'));
  assert.ok(isRateLimitError('was submitted too quickly'));
  assert.ok(!isRateLimitError('GraphQL: Could not resolve to a PullRequest with the number of 5.'));
});

test('a probe under the floor blocks until the reset, and a later good probe lifts the block', () => {
  const low = applyProbe({}, { remaining: FLOOR - 1, limit: 5000, resetAt: RESET }, T0);
  assert.equal(blockedUntil(low, T0), RESET);
  assert.equal(blockedUntil(low, RESET + 1), null);
  assert.match(low.reason ?? '', /299 of 5000/);
  const ok = applyProbe(low, { remaining: 4000, limit: 5000, resetAt: RESET }, T0 + 1000);
  assert.equal(blockedUntil(ok, T0 + 1000), null);
  assert.equal(ok.failures, 0);
});

test('failures back off 2, 4, 8 minutes, capped, and never past a known reset when under the floor', () => {
  let s = applyFailure({}, T0);
  assert.equal(s.blockedUntil, T0 + 2 * 60_000);
  s = applyFailure(s, T0);
  assert.equal(s.blockedUntil, T0 + 4 * 60_000);
  for (let i = 0; i < 10; i++) s = applyFailure(s, T0);
  assert.equal(s.blockedUntil, T0 + MAX_BACKOFF_MS);
  const known = applyFailure({ remaining: 10, resetAt: RESET }, T0);
  assert.equal(known.blockedUntil, RESET);
});

test('a probe is trusted for two minutes', () => {
  assert.ok(needsProbe({}, T0));
  assert.ok(!needsProbe({ probedAt: T0 }, T0 + PROBE_MS - 1));
  assert.ok(needsProbe({ probedAt: T0 }, T0 + PROBE_MS));
});

test('state and the call log survive a round trip, and a damaged state file reads as empty', () => {
  const d = dir();
  assert.deepEqual(readState(d), {});
  writeState(d, { remaining: 5, blockedUntil: RESET });
  assert.deepEqual(readState(d), { remaining: 5, blockedUntil: RESET });
  appendCall(d, { t: T0, kind: 'graphql', caller: 'a.ts', cmd: 'pr view', status: 0 });
  appendCall(d, { t: T0 + 10, kind: 'graphql', caller: 'a.ts', cmd: 'pr view', status: 0 });
  appendCall(d, { t: T0 + 20, kind: 'rest', caller: 'b.ts', cmd: 'api user', status: 0 });
  assert.equal(readCalls(d, T0).length, 3);
  assert.equal(readCalls(d, T0 + 15).length, 1);
  assert.deepEqual(callsPerHour(readCalls(d, T0), 2), [['a.ts', 'graphql', 1], ['b.ts', 'rest', 0.5]]);
});

test('limitedText names the reset time in the given zone, and is empty when not blocked', () => {
  assert.equal(limitedText({}, T0), '');
  const text = limitedText({ blockedUntil: RESET, reason: '12 of 5000 GraphQL points left' }, T0, 'America/New_York');
  assert.equal(text, 'limited until 10:23 pm EDT (12 of 5000 GraphQL points left)');
});
