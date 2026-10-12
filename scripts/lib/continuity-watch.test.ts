import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuityWatchProblem } from './continuity-watch.ts';
import type { Watch } from './types.ts';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const watch = (over: Partial<Watch> = {}): Watch => ({ op: 'add', id: 'continuity', type: 'continuity', target: '/t', done_when: '', report: '', created: '2026-10-10T12:00:00.000Z', expires: '2026-10-13T12:00:00.000Z', notify_overnight: false, notify: false, interval: null, ...over } as Watch);
const ok = { state: 'ok' as const };

test('a registered, unexpired continuity watch with a healthy loop raises nothing', () => {
  assert.equal(continuityWatchProblem([watch()], ok, NOW), null);
  assert.equal(continuityWatchProblem([watch()], { state: 'quiet' }, NOW), null, 'quiet hours are the loop waiting as planned');
});

test('no continuity watch is one actionable line naming the register command', () => {
  const p = continuityWatchProblem([watch({ type: 'inbox', id: 'inbox' })], ok, NOW);
  assert.match(p ?? '', /^not registered; run `node scripts\/event-loop\.ts add --id continuity --type continuity --target <transcripts dir>/);
  assert.ok(!(p ?? '').includes('\n'));
});

test('an expired watch counts as not registered', () => {
  assert.match(continuityWatchProblem([watch({ expires: '2026-10-11T11:00:00.000Z' })], ok, NOW) ?? '', /^not registered/);
});

test('a registered watch with a stalled, down or absent loop says the loop is not alive', () => {
  for (const state of ['stalled', 'down', 'not-installed', 'absent'] as const) {
    assert.match(continuityWatchProblem([watch()], { state }, NOW) ?? '', /^registered but the event loop is not alive \(/, state);
  }
});
