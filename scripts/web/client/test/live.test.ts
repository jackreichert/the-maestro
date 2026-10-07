// Run: node --test scripts/web/client/test/live.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveUpdates, POLL_MS, liveLabel } from '../src/live.ts';
import type { LiveStatus, StreamLike } from '../src/live.ts';

class FakeStream implements StreamLike {
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  #changed: Array<() => void> = [];
  addEventListener(_type: 'changed', fn: () => void): void { this.#changed.push(fn); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.(new Event('open')); }
  fail(): void { this.onerror?.(new Event('error')); }
  push(): void { for (const fn of this.#changed) fn(); }
}

interface Data { seq: string }
/** A harness with a manual clock and loads that the test settles by hand, so ordering is under its control. */
function harness(opts: { stream?: FakeStream | null; shown?: string } = {}) {
  const stream = opts.stream === undefined ? new FakeStream() : opts.stream;
  const applied: string[] = [];
  const statuses: LiveStatus[] = [];
  const loads: Array<{ ok: (d: Data | null) => void; fail: () => void }> = [];
  let timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  let fetched = 0;
  const live = new LiveUpdates<Data>({
    open: () => stream,
    load: () => { fetched += 1; return new Promise((ok, fail) => { loads.push({ ok, fail: () => fail(new Error('down')) }); }); },
    seqOf: (d) => d.seq,
    apply: (d) => applied.push(d.seq),
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
  }, opts.shown ?? 's0');
  const tick = (): void => { const t = timers.shift(); t?.fn(); };
  const fireAll = (): void => { const due = timers; timers = []; for (const t of due) t.fn(); };
  const settle = (): Promise<void> => new Promise((ok) => setImmediate(ok));
  return { live, stream, applied, statuses, loads, tick, fireAll, settle, timers: () => timers, fetched: () => fetched };
}

test('a changed event reloads, and a new seq is applied while the stream is live', async () => {
  const h = harness();
  h.live.start();
  h.stream?.open();
  assert.deepEqual(h.statuses, ['live']);
  h.loads.shift()?.ok({ seq: 's0' });   // the catch-up load on open: nothing new
  await h.settle();
  h.stream?.push();
  h.loads.shift()?.ok({ seq: 's1' });
  await h.settle();
  assert.deepEqual(h.applied, ['s1']);
  assert.equal(h.live.status, 'live');
  assert.equal(h.timers().length, 0, 'no polling while the stream is up');
});

test('an unchanged seq is not applied again', async () => {
  const h = harness({ shown: 's7' });
  h.live.start();
  h.stream?.open();
  h.loads.shift()?.ok({ seq: 's7' });
  await h.settle();
  assert.deepEqual(h.applied, []);
});

test('a slow answer to an older request never overwrites a newer one', async () => {
  const h = harness();
  h.live.start();
  h.stream?.open();
  h.stream?.push();
  h.stream?.push();
  const [catchUp, older, newer] = h.loads;
  newer?.ok({ seq: 'new' });
  await h.settle();
  older?.ok({ seq: 'old' });
  catchUp?.ok({ seq: 'older' });
  await h.settle();
  assert.deepEqual(h.applied, ['new']);
});

test('a stream error starts polling every 30 s; reconnecting stops it and catches up', async () => {
  const h = harness();
  h.live.start();
  h.stream?.open();
  h.loads.shift()?.ok({ seq: 's0' });
  h.stream?.fail();
  assert.equal(h.live.status, 'polling');
  assert.equal(h.timers().length, 1);
  assert.equal(h.timers()[0]?.ms, POLL_MS);
  h.loads.shift()?.ok({ seq: 's1' });   // the load started when polling began
  await h.settle();
  h.tick();
  h.loads.shift()?.ok({ seq: 's2' });
  await h.settle();
  assert.deepEqual(h.applied, ['s1', 's2']);
  assert.equal(h.timers().length, 1, 'the next poll is scheduled');
  h.stream?.open();
  assert.equal(h.live.status, 'live');
  assert.equal(h.timers().length, 0, 'polling stopped');
});

test('with no EventSource it polls from the start', async () => {
  const h = harness({ stream: null });
  h.live.start();
  assert.equal(h.live.status, 'polling');
  assert.equal(h.timers().length, 1);
  h.loads.shift()?.ok({ seq: 'a' });
  await h.settle();
  assert.deepEqual(h.applied, ['a']);
});

test('a failed or empty load is offline, and the next good one recovers', async () => {
  const h = harness({ stream: null });
  h.live.start();
  h.loads.shift()?.fail();
  await h.settle();
  assert.equal(h.live.status, 'offline');
  h.tick();
  h.loads.shift()?.ok(null);
  await h.settle();
  assert.equal(h.live.status, 'offline');
  h.tick();
  h.loads.shift()?.ok({ seq: 'b' });
  await h.settle();
  assert.equal(h.live.status, 'polling');
  assert.deepEqual(h.applied, ['b']);
  assert.deepEqual(h.statuses, ['polling', 'offline', 'polling']);
});

test('stop closes the stream, clears the timer, and drops an answer still in flight', async () => {
  const h = harness();
  h.live.start();
  h.stream?.fail();
  h.live.stop();
  assert.equal(h.stream?.closed, true);
  assert.equal(h.timers().length, 0);
  h.loads.shift()?.ok({ seq: 'late' });
  await h.settle();
  assert.deepEqual(h.applied, []);
});

test('a stream that flaps twice leaves one polling loop, and stop leaves none', async () => {
  const h = harness();
  h.live.start();
  h.stream?.fail();                       // polling: timer A, load 0
  h.loads.shift()?.ok({ seq: 's0' });
  await h.settle();
  const firedA = h.timers()[0]?.fn;       // timer A fires: its load (the stray) is now in flight
  h.tick();
  const stray = h.loads.shift();
  h.stream?.open();                       // stream back: polling stops, catch-up load
  h.loads.shift()?.ok({ seq: 's0' });
  h.stream?.fail();                       // down again: timer B, load
  h.loads.shift()?.ok({ seq: 's0' });
  await h.settle();
  stray?.ok({ seq: 's0' });               // the stray load settles while B is pending
  await h.settle();
  assert.equal(h.timers().length, 1, 'one pending timer, not a second loop');

  const before = h.fetched();
  for (let period = 0; period < 3; period += 1) {
    h.fireAll();
    while (h.loads.length > 0) h.loads.shift()?.ok({ seq: 's0' });
    await h.settle();
  }
  assert.equal(h.fetched() - before, 3, 'one fetch per period (two loops would make 6)');
  assert.equal(h.timers().length, 1);

  h.live.stop();
  assert.equal(h.timers().length, 0);
  const after = h.fetched();   // a timer callback that had already fired before stop must not fetch
  firedA?.();
  assert.equal(h.fetched(), after, 'no fetch after stop');
});

test('the indicator says its mode in words', () => {
  assert.equal(liveLabel('live'), 'Updates live');
  assert.equal(liveLabel('polling'), 'Checking every 30 s');
  assert.equal(liveLabel('offline'), 'Offline, retrying');
  assert.equal(liveLabel(null), '');
});
