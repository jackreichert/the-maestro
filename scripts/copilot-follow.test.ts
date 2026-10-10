// Run: node --test scripts/copilot-follow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATE_MS, GRACE_MS, MAX_ATTEMPTS, advance, begin, requestReview, trackKey } from './lib/copilot-follow.ts';
import type { Observation, Track } from './lib/copilot-follow.ts';
import type { Run } from './lib/types.ts';

const T0 = Date.parse('2026-10-09T12:00:00Z');
const none: Observation = { pending: false, reviewed: false, botThreads: 0 };

/** Drives one head through ticks; `asks` counts calls to the request and `ok` decides whether gh accepts it. */
function drive(ok = true) {
  let track: Track = begin(T0, false);
  const asks: number[] = [];
  const lines: string[] = [];
  return {
    asks, lines,
    get track() { return track; },
    tick(at: number, obs: Observation = none) {
      const out = advance('org/repo#7', 'abcdef1234', track, obs, T0 + at, () => { asks.push(at); return ok; });
      track = out.track;
      lines.push(...out.events.map((e) => e.summary));
      return out;
    },
  };
}

test('a head Copilot has not touched is requested once the grace has passed, and not before', () => {
  const d = drive();
  d.tick(GRACE_MS - 1);
  assert.deepEqual(d.asks, []);
  d.tick(GRACE_MS);
  assert.deepEqual(d.asks, [GRACE_MS]);
  assert.equal(d.track.phase, 'triggered');
});

test('once per head sha: later ticks, a review, and a late escalation never ask again', () => {
  const d = drive();
  d.tick(GRACE_MS);
  d.tick(GRACE_MS + 120_000);
  d.tick(GRACE_MS + 400_000, { pending: false, reviewed: true, botThreads: 2 });
  d.tick(GRACE_MS + 2_000_000);
  assert.deepEqual(d.asks, [GRACE_MS]);
  assert.equal(d.track.phase, 'done');
});

test('Copilot re-triggering itself inside the grace means no request at all', () => {
  const d = drive();
  d.tick(30_000, { ...none, pending: true });
  d.tick(GRACE_MS + 1_000, { ...none, pending: true });
  assert.deepEqual(d.asks, []);
  assert.equal(d.track.phase, 'triggered');
});

test('a review on the sha reports once, with the unresolved bot thread count, and is quiet after', () => {
  const d = drive();
  d.tick(GRACE_MS);
  const out = d.tick(GRACE_MS + 200_000, { pending: false, reviewed: true, botThreads: 3 });
  assert.deepEqual(out.events, [{ summary: 'COPILOT-REVIEW org/repo#7 abcdef1: reviewed, 3 unresolved bot threads', actionable: true }]);
  assert.deepEqual(d.tick(GRACE_MS + 400_000, { pending: false, reviewed: true, botThreads: 3 }).events, []);
});

test('a clean review (no bot threads) is informational', () => {
  const d = drive();
  d.tick(GRACE_MS);
  const [event] = d.tick(GRACE_MS + 200_000, { pending: false, reviewed: true, botThreads: 0 }).events;
  assert.equal(event?.actionable, false);
  assert.match(event?.summary ?? '', /0 unresolved bot threads/);
});

test('escalation: nothing 15 minutes after the trigger raises one COPILOT-LATE, not before, and not twice', () => {
  const d = drive();
  d.tick(GRACE_MS);
  assert.deepEqual(d.tick(GRACE_MS + ESCALATE_MS - 1, { ...none, pending: true }).events, []);
  const [late] = d.tick(GRACE_MS + ESCALATE_MS, { ...none, pending: true }).events;
  assert.match(late?.summary ?? '', /^COPILOT-LATE org\/repo#7 abcdef1: no Copilot review 15 min/);
  assert.equal(late?.actionable, true);
  assert.deepEqual(d.tick(GRACE_MS + ESCALATE_MS + 600_000, { ...none, pending: true }).events, []);
});

test('the escalation clock starts at the trigger, not at the push', () => {
  const d = drive();
  d.tick(0, { ...none, pending: true });
  assert.deepEqual(d.tick(ESCALATE_MS - 1).events, []);
  assert.equal(d.tick(ESCALATE_MS).events.length, 1);
});

test('a failed request is retried on the next tick, and gives up loudly after the cap', () => {
  const d = drive(false);
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) assert.deepEqual(d.tick(GRACE_MS + i * 1000).events, []);
  assert.equal(d.track.phase, 'watching');
  const [failed] = d.tick(GRACE_MS + 9000).events;
  assert.match(failed?.summary ?? '', /^COPILOT-REQUEST-FAILED /);
  assert.equal(d.asks.length, MAX_ATTEMPTS);
  d.tick(GRACE_MS + 20_000);
  assert.equal(d.asks.length, MAX_ATTEMPTS, 'given up: no more asks');
});

test('an adopted head is already told: nothing is asked or reported for it', () => {
  const track = begin(T0, true);
  const out = advance('org/repo#7', 'abcdef1234', track, none, T0 + 99 * 60_000, () => assert.fail('must not ask'));
  assert.deepEqual(out, { track, events: [] });
});

test('trackKey separates heads of one PR', () => {
  assert.notEqual(trackKey('org/repo#7', 'a'), trackKey('org/repo#7', 'b'));
});

test('requestReview adds @copilot through the injected gh and reports whether it was accepted', () => {
  const calls: string[][] = [];
  const run = (status: number): Run => (cmd, args) => { calls.push([cmd, ...args]); return { status, stdout: '', stderr: '' }; };
  assert.equal(requestReview(run(0), 'org/repo', 7), true);
  assert.equal(requestReview(run(1), 'org/repo', 7), false);
  assert.deepEqual(calls[0], ['gh', 'pr', 'edit', '7', '--repo', 'org/repo', '--add-reviewer', '@copilot']);
});
