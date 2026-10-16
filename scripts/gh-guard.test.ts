import './lib/hermetic-config.ts';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCalls, readState, writeState } from './lib/gh-budget.ts';
import { runGuarded } from './gh-guard.ts';
import type { GuardDeps } from './gh-guard.ts';

const T0 = Date.parse('2026-10-16T01:00:00Z');
const RESET = new Date(T0 + 3600_000).toISOString();

/** A guard whose gh is a script of answers: probes get `probe`, every other call gets `call`. Records what reached gh. */
function rig(probe: { status: number; stdout: string; stderr: string }, call: { status: number; stderr: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-guard-'));
  const sent: string[][] = [];
  const errs: string[] = [];
  let now = T0;
  const deps: GuardDeps = {
    dir, now: () => now, caller: 'test.ts', tz: 'UTC', err: (t) => errs.push(t),
    gh: (args) => { sent.push(args); return args[0] === 'api' && args[3]?.includes('rateLimit') ? probe : { status: call.status, stdout: '', stderr: call.stderr }; },
  };
  return { dir, sent, errs, deps, advance: (ms: number) => { now += ms; } };
}
const probeOf = (remaining: number) => ({ status: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining, resetAt: RESET } } }), stderr: '' });
const hasProbe = (sent: string[][]): boolean => sent.some((a) => a[3]?.includes('rateLimit'));

test('with budget to spare a GraphQL call goes through, after one probe, and is logged', () => {
  const r = rig(probeOf(4000), { status: 0, stderr: '' });
  assert.equal(runGuarded(['pr', 'view', '1'], r.deps), 0);
  assert.ok(hasProbe(r.sent));
  assert.deepEqual(r.sent.at(-1), ['pr', 'view', '1']);
  assert.deepEqual(readCalls(r.dir, 0).map((c) => [c.caller, c.kind, c.cmd, c.status]), [['test.ts', 'graphql', 'pr view', 0]]);
  runGuarded(['pr', 'view', '2'], r.deps);
  assert.equal(r.sent.filter((a) => a[3]?.includes('rateLimit')).length, 1, 'the probe is trusted for two minutes');
});

test('under the floor a GraphQL call is refused without reaching gh, and says when it clears', () => {
  const r = rig(probeOf(12), { status: 0, stderr: '' });
  assert.equal(runGuarded(['pr', 'checks', '1'], r.deps), 1);
  assert.deepEqual(r.sent.filter((a) => a[0] === 'pr'), []);
  assert.match(r.errs.join(''), /GitHub limited until 2:00 AM UTC/i);
  assert.deepEqual(readCalls(r.dir, 0).map((c) => c.cmd), ['pr checks (blocked)']);
});

test('REST and free calls are never refused, even while GraphQL is blocked', () => {
  const r = rig(probeOf(0), { status: 0, stderr: '' });
  runGuarded(['pr', 'view', '1'], r.deps);
  assert.equal(runGuarded(['api', 'user'], r.deps), 0);
  assert.equal(runGuarded(['auth', 'status'], r.deps), 0);
});

test('a rate-limited call starts a backoff, and the next call is refused until it passes', () => {
  const r = rig(probeOf(4000), { status: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' });
  assert.equal(runGuarded(['pr', 'view', '1'], r.deps), 1);
  assert.equal(readState(r.dir).failures, 1);
  r.sent.length = 0;
  assert.equal(runGuarded(['pr', 'view', '2'], r.deps), 1);
  assert.deepEqual(r.sent.filter((a) => a[0] === 'pr'), [], 'refused, not sent');
  r.advance(3 * 60_000);
  runGuarded(['pr', 'view', '3'], r.deps);
  assert.deepEqual(r.sent.filter((a) => a[0] === 'pr'), [['pr', 'view', '3']], 'sent again once the backoff and the probe interval passed');
});

test('a probe that is itself rate-limited blocks, and a failed probe for any other reason does not', () => {
  const limited = rig({ status: 1, stdout: '', stderr: 'API rate limit already exceeded' }, { status: 0, stderr: '' });
  assert.equal(runGuarded(['pr', 'view', '1'], limited.deps), 1);
  const offline = rig({ status: 1, stdout: '', stderr: 'error connecting to api.github.com' }, { status: 0, stderr: '' });
  assert.equal(runGuarded(['pr', 'view', '1'], offline.deps), 0);
});

test('a call that fails for another reason passes its status through and starts no backoff', () => {
  const r = rig(probeOf(4000), { status: 8, stderr: 'some checks pending' });
  assert.equal(runGuarded(['pr', 'checks', '1'], r.deps), 8);
  assert.equal(readState(r.dir).blockedUntil, undefined);
  writeState(r.dir, {});
});
