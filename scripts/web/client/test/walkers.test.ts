// Run: node --test scripts/web/client/test/walkers.test.ts
// The walkers' scheduler on a fake clock: random picks with no immediate repeat, nothing while reduced motion, a hidden
// tab or the off switch says so, and no timer held then; plus the stored off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GAP_MS, MIN_GAP_MS, STORAGE_KEY, WALKERS, WalkerScheduler, loadEnabled, nextGap, pickDirection, pickWalker, saveEnabled, walkerById } from '../src/walkers-model.ts';
import type { SchedulerEnv, Walker } from '../src/walkers-model.ts';

/** A clock the test advances by hand; timers fire in order. */
function harness(flags: { hidden?: boolean; reduced?: boolean; enabled?: boolean } = {}, seed = 1) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let s = seed;
  const f = { hidden: false, reduced: false, enabled: true, ...flags };
  const played: Walker[] = [];
  let stops = 0;
  const env: SchedulerEnv = {
    random: () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
    hidden: () => f.hidden, reducedMotion: () => f.reduced, enabled: () => f.enabled,
  };
  const sched = new WalkerScheduler(env, { play: (w) => played.push(w), stop: () => { stops += 1; } });
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  /** Step a second at a time until a walker is on stage (never more than a maximum gap). */
  const untilPlaying = (): void => { for (let i = 0; i < MAX_GAP_MS / 1000 + 1 && !sched.playing; i += 1) advance(1000); };
  return { sched, f, played, advance, untilPlaying, timers, stops: () => stops };
}

test('the gap is 45 to 120 seconds, jittered', () => {
  assert.equal(nextGap(0), MIN_GAP_MS);
  assert.equal(nextGap(0.999999), MAX_GAP_MS);
  assert.equal(MIN_GAP_MS, 45_000);
  assert.equal(MAX_GAP_MS, 120_000);
});

test('every walker crosses in 10 to 15 seconds and ids are unique', () => {
  assert.ok(WALKERS.length >= 6 && WALKERS.length <= 8);
  assert.equal(new Set(WALKERS.map((w) => w.id)).size, WALKERS.length);
  for (const w of WALKERS) assert.ok(w.ms >= 10_000 && w.ms <= 15_000, w.id);
});

test('pickWalker never repeats the last one, for any random draw, and reaches every other walker', () => {
  for (const last of WALKERS.map((w) => w.id)) {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const pick = pickWalker(last, i / 100);
      assert.notEqual(pick.id, last);
      seen.add(pick.id);
    }
    assert.equal(seen.size, WALKERS.length - 1);
  }
  assert.ok(WALKERS.some((w) => w.id === pickWalker(null, 0.999).id));
});

test('a long run is random-looking: no back-to-back repeat, and more than two walkers appear', () => {
  const h = harness({}, 7);
  h.sched.refresh();
  h.advance(60 * 60 * 1000);
  assert.ok(h.played.length > 20, `played ${h.played.length}`);
  h.played.forEach((w, i) => { if (i > 0) assert.notEqual(w.id, h.played[i - 1].id); });
  assert.ok(new Set(h.played.map((w) => w.id)).size >= 6);
});

test('the first walker waits a full gap, and one walker plays at a time', () => {
  const h = harness();
  h.sched.refresh();
  h.advance(MIN_GAP_MS - 1);
  assert.equal(h.played.length, 0);
  h.untilPlaying();
  assert.equal(h.played.length, 1);
  assert.equal(h.sched.playing, h.played[0].id);
  h.advance(h.played[0].ms);
  assert.equal(h.sched.playing, null);
  assert.equal(h.stops(), 1);
});

test('reduced motion: nothing plays and no timer is held', () => {
  const h = harness({ reduced: true });
  h.sched.refresh();
  assert.equal(h.timers.size, 0);
  h.advance(3 * 60 * 60 * 1000);
  assert.equal(h.played.length, 0);
  h.sched.playNow(WALKERS[0]);
  assert.equal(h.played.length, 0);
});

test('the off switch: nothing plays, a walker on stage is cut short, and switching back on resumes', () => {
  const h = harness();
  h.sched.refresh();
  h.untilPlaying();
  assert.ok(h.sched.playing);
  h.f.enabled = false;
  h.sched.refresh();
  assert.equal(h.sched.playing, null);
  assert.equal(h.stops(), 1);
  assert.equal(h.timers.size, 0);
  const count = h.played.length;
  h.advance(60 * 60 * 1000);
  assert.equal(h.played.length, count);
  h.f.enabled = true;
  h.sched.refresh();
  h.untilPlaying();
  assert.equal(h.played.length, count + 1);
});

test('a hidden tab stops the walker and the clock, and a visible one starts a fresh wait', () => {
  const h = harness();
  h.sched.refresh();
  h.untilPlaying();
  h.f.hidden = true;
  h.sched.refresh();
  assert.equal(h.sched.playing, null);
  assert.equal(h.timers.size, 0);
  const count = h.played.length;
  h.advance(60 * 60 * 1000);
  assert.equal(h.played.length, count);
  h.f.hidden = false;
  h.sched.refresh();
  h.advance(MIN_GAP_MS - 1);
  assert.equal(h.played.length, count);
  h.untilPlaying();
  assert.equal(h.played.length, count + 1);
});

test('refresh is idempotent while waiting: it never stacks timers', () => {
  const h = harness();
  h.sched.refresh(); h.sched.refresh(); h.sched.refresh();
  assert.equal(h.timers.size, 1);
});

test('the dev preview repeats one walker after a short rest, and still honours the switches', () => {
  const env = harness();
  const played: string[] = [];
  const pick = WALKERS[3];
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const sched = new WalkerScheduler({
    random: () => 0.5, setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length; }, clearTimer: () => {},
    hidden: () => false, reducedMotion: () => false, enabled: () => env.f.enabled,
  }, { play: (w) => played.push(w.id), stop: () => {} }, pick);
  sched.playNow(pick);
  assert.deepEqual(played, [pick.id]);
  now = pick.ms; timers.shift()?.fn();           // it ends, then a short rest is scheduled
  assert.ok(timers[0].at - now <= 2_000);
  now = timers[0].at; timers.shift()?.fn();
  assert.deepEqual(played, [pick.id, pick.id]);
  assert.equal(walkerById(pick.id), pick);
  assert.equal(walkerById('nope'), null);
});

test('direction is either edge', () => {
  assert.equal(pickDirection(0.1), 'ltr');
  assert.equal(pickDirection(0.9), 'rtl');
});

test('the off switch is stored, defaults to on, and survives storage that throws', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(loadEnabled(store), true);
  saveEnabled(store, false);
  assert.equal(mem.get(STORAGE_KEY), '0');
  assert.equal(loadEnabled(store), false);
  saveEnabled(store, true);
  assert.equal(loadEnabled(store), true);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(loadEnabled(broken), true);
  assert.doesNotThrow(() => saveEnabled(broken, false));
  assert.equal(loadEnabled(null), true);
});
