// Run: node --test scripts/cold-start-gate-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as gate from './event-types/cold-start-gate.ts';
import type { ColdStartGateState } from './event-types/cold-start-gate.ts';
import type { Run } from './lib/types.ts';

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-10-12T13:00:00Z');
const answer = (stdout: string, status = 0): Run => () => ({ status, stdout, stderr: '' });
const PASS = answer('real-state gate: ok\ngate-result {"ok":true,"checked":498,"missing":0,"pending":3}\n');
const FAIL = answer('real-state gate: FAILED\n  MISSING startup: open-id abc1\n  MISSING compact: open-id abc1\n  MISSING clear: ask zz99\ngate-result {"ok":false,"checked":498,"missing":3,"pending":0}\n', 1);

function step(prev: ColdStartGateState | null, now: number, run: Run) {
  const next = gate.check('dev-env', { now, prev, run });
  return { next, events: gate.diff(prev, next) };
}

test('the type is registered, singleton and renewing', () => {
  assert.equal(BUILTIN_TYPES['cold-start-gate'], gate);
  assert.equal(gate.singleton, true);
  assert.equal(gate.renews, true);
});

test('a clean run is silent and is not repeated for a week', () => {
  let calls = 0;
  const counting: Run = (c, a) => { calls += 1; return PASS(c, a); };
  const first = step(null, T0, counting);
  assert.deepEqual(first.events, []);
  assert.equal(first.next.last, 'ok, 498 checks, 3 pending');
  assert.equal(step(first.next, T0 + 6 * DAY, counting).next, first.next);
  assert.equal(calls, 1);
  step(first.next, T0 + 7 * DAY, counting);
  assert.equal(calls, 2);
});

test('missing facts raise one actionable event naming ids only, retried daily without repeating it', () => {
  const first = step(null, T0, FAIL);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.actionable, true);
  assert.equal(first.events[0]?.summary, 'cold-start gate failed: 3 facts missing from the start context (abc1, zz99)');
  assert.equal(step(first.next, T0 + DAY / 2, FAIL).next, first.next);
  assert.deepEqual(step(first.next, T0 + DAY, FAIL).events, []);
});

test('a gate that prints no result is a failure to run, raised once', () => {
  const r = step(null, T0, () => ({ status: 2, stdout: '', stderr: 'real-state gate: no ledger.jsonl in x\n' }));
  assert.match(r.events[0]?.summary ?? '', /gate printed no result \(exit 2\): real-state gate: no ledger\.jsonl in x/);
});

test('a failure that is then fixed clears the error and reports nothing new', () => {
  const failed = step(null, T0, FAIL).next;
  const fixed = step(failed, T0 + DAY, PASS);
  assert.equal(fixed.next.error, '');
  assert.deepEqual(fixed.events, []);
});

test('validate refuses a path-like target', () => {
  assert.doesNotThrow(() => gate.validate('dev-env'));
  assert.throws(() => gate.validate('../x'), /project name/);
});
