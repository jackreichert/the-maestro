// Run: node --test scripts/status-refresh-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as pr from './event-types/pr-merged.ts';
import * as refresh from './event-types/status-refresh.ts';
import type { RefreshIo, StatusRefreshState } from './event-types/status-refresh.ts';
import { markPrsDirty, prsDirtyAt } from './lib/status-page/dirty.ts';
import { addWatch } from './lib/watch-registry.ts';

const T0 = Date.parse('2026-10-05T15:00:00Z');
const SEC = 1000;

interface Rig { io: RefreshIo; runs: { at: number; cachedPrsOnly: boolean }[]; snaps: number[]; set: (k: Partial<World>) => void; step: (seconds: number) => StatusRefreshState; at: () => number }
interface World { gh: string; sig: string; marker: number; editAt: number | null; fetchedAt: number; quiet: boolean; fail: boolean; snapAt: number; snapFail: string }

/** A fake world and a clock: `step(n)` moves n seconds and runs one check, carrying the state like the loop does. */
function rig(): Rig {
  let now = T0;
  let state: StatusRefreshState | null = null;
  const w: World = { gh: '', sig: 'a', marker: 0, editAt: null, fetchedAt: T0, quiet: false, fail: false, snapAt: T0, snapFail: '' };
  const runs: Rig['runs'] = [];
  const snaps: number[] = [];
  const io: RefreshIo = {
    ledgerSig: () => w.sig, prsDirtyAt: () => w.marker, userEditAt: () => w.editAt, pageAt: () => T0, prsFetchedAt: () => w.fetchedAt, isQuiet: () => w.quiet,
    regenerate: (_dir, cachedPrsOnly) => { if (w.fail) throw new Error('ledger read failed'); runs.push({ at: now, cachedPrsOnly }); if (!cachedPrsOnly && !w.gh) w.fetchedAt = now; return cachedPrsOnly ? undefined : w.gh || undefined; },
    snapshotAt: () => w.snapAt,
    refreshSnapshot: () => { snaps.push(now); if (w.snapFail) return w.snapFail; w.snapAt = now; return undefined; },
  };
  return {
    io, runs, snaps, set: (k) => Object.assign(w, k), at: () => now,
    step: (seconds) => { now += seconds * SEC; state = refresh.check('dir', { now, prev: state }, io); return state; },
  };
}

/** Checks every 30 s for `seconds`, as the loop would. */
const run = (r: Rig, seconds: number): void => { for (let s = 0; s < seconds; s += 30) r.step(30); };

test('a ledger write gives exactly one regeneration, within 75 s, from the cached PRs', () => {
  const r = rig();
  r.step(30);
  const wrote = r.at();
  r.set({ sig: 'b' });
  run(r, 120);
  assert.equal(r.runs.length, 1);
  assert.ok((r.runs[0] as { at: number }).at - wrote <= 75 * SEC, 'within 75 s of the write');
  assert.equal((r.runs[0] as { cachedPrsOnly: boolean }).cachedPrsOnly, true, 'PR data was fresh, so no GitHub read');
});

test('a burst of ledger writes is one regeneration, never more than 60 s after the first', () => {
  const r = rig();
  r.step(30);
  const first = r.at();
  for (let i = 0; i < 6; i++) { r.set({ sig: `w${i}` }); r.step(10); }
  run(r, 120);
  assert.equal(r.runs.length, 1);
  assert.ok((r.runs[0] as { at: number }).at - first <= 90 * SEC, 'the 60 s cap, plus one check interval');
});

test('two triggers in one window give one run, and it reads GitHub because the PR data is dirty', () => {
  const r = rig();
  r.step(30);
  r.set({ sig: 'b', marker: r.at() });
  run(r, 120);
  assert.deepEqual(r.runs.map((x) => x.cachedPrsOnly), [false]);
});

test('a hand edit under 60 s old defers the refresh, which runs after the window', () => {
  const r = rig();
  r.step(30);
  r.set({ sig: 'b', editAt: r.at() });
  r.step(30);
  assert.equal(r.runs.length, 0, 'the edit is 30 s old: nothing is written, though the debounce has passed');
  r.set({ editAt: r.at() });
  r.step(30);
  assert.equal(r.runs.length, 0, 'a second save restarts the window');
  r.step(30);
  assert.equal(r.runs.length, 1, 'once the window has passed the deferred refresh runs');
  run(r, 60);
  assert.equal(r.runs.length, 1, 'and only once');
});

test('the idle tick fires at 10 minutes, and reads GitHub only because the PR data is over 5 minutes old', () => {
  const r = rig();
  run(r, 570);
  assert.equal(r.runs.length, 0);
  r.step(30);
  assert.equal(r.runs.length, 1);
  assert.equal((r.runs[0] as { at: number }).at - T0, 600 * SEC);
  assert.equal((r.runs[0] as { cachedPrsOnly: boolean }).cachedPrsOnly, false);
  run(r, 570);
  assert.equal(r.runs.length, 1, 'the next tick is 10 minutes after this run');
});

test('quiet hours rebuild from the ledger only and leave the PR data dirty for later', () => {
  const r = rig();
  r.step(30);
  r.set({ sig: 'b', marker: r.at(), quiet: true });
  run(r, 120);
  assert.deepEqual(r.runs.map((x) => x.cachedPrsOnly), [true], 'no GitHub read overnight');
  r.set({ quiet: false, sig: 'c' });
  run(r, 120);
  assert.deepEqual(r.runs.map((x) => x.cachedPrsOnly), [true, false], 'the dirty PR data is read at the next refresh in waking hours');
});

test('a failed regeneration is retried after 2 minutes and reported once, without waking anyone', () => {
  const r = rig();
  r.step(30);
  r.set({ sig: 'b', fail: true });
  const events: string[] = [];
  let prev: StatusRefreshState | null = null;
  for (let i = 0; i < 8; i++) {
    const next = r.step(30);
    events.push(...refresh.diff(prev, next).map((e) => `${e.actionable}:${e.summary}`));
    prev = next;
  }
  assert.deepEqual(events, ['false:status page refresh failed: ledger read failed']);
  r.set({ fail: false });
  run(r, 150);
  assert.equal(r.runs.length, 1);
});

test('a GitHub failure keeps the PR data dirty, so the next refresh reads again', () => {
  const r = rig();
  r.step(30);
  r.set({ sig: 'b', marker: r.at(), gh: 'HTTP 502' });
  run(r, 120);
  r.set({ gh: '', sig: 'c' });
  run(r, 120);
  assert.deepEqual(r.runs.map((x) => x.cachedPrsOnly), [false, false]);
});

test('a check that cannot read the page reports information and retries, never throws', () => {
  const r = rig();
  r.step(30);
  const broken: RefreshIo = { ...r.io, userEditAt: () => { throw new Error('EACCES: NOW.md'); } };
  r.set({ sig: 'b' });
  let state = refresh.check('dir', { now: r.at() + 90 * SEC, prev: null }, broken);
  state = refresh.check('dir', { now: r.at() + 700 * SEC, prev: state }, broken);
  assert.match(state.error, /EACCES/);
  assert.deepEqual(refresh.diff(null, state).map((e) => e.actionable), [false]);
});

test('the loop never exits 10 because of a refresh: a regeneration produces no actionable event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-'));
  const target = mkdtempSync(join(tmpdir(), 'sr-status-'));
  writeFileSync(join(target, 'The-Podium.md'), 'page\n');
  let ran = 0;
  const io: RefreshIo = { ...rig().io, ledgerSig: () => String(Math.floor(ran / 1)), regenerate: () => { ran++; return undefined; }, pageAt: () => 0 };
  const types = { ...BUILTIN_TYPES, 'status-refresh': { ...refresh, check: (t: string, c: Parameters<typeof refresh.check>[1]) => refresh.check(t, c, io) } };
  addWatch(dir, { id: 'sr', type: 'status-refresh', target, done_when: '', report: '', notify_overnight: false, notify: false, interval: null, ttlMs: 86_400_000 }, T0);
  const config = { quietHours: 'off' };
  const out = tick({ dir, types, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config, now: T0 });
  assert.equal(ran, 1, 'the page was regenerated (it had no write time)');
  assert.deepEqual(out.events.filter((e) => e.actionable), []);
});

test('the PR-dirty marker is touched on demand, only in a directory that exists, and read back by its time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-mark-'));
  assert.equal(prsDirtyAt(dir), 0);
  markPrsDirty(dir);
  assert.ok(prsDirtyAt(dir) > 0);
  markPrsDirty(join(dir, 'missing'));
  assert.equal(existsSync(join(dir, 'missing')), false, 'a missing status directory is not created');
  const merged = { state: 'MERGED', repo: 'o/r', number: '1', title: 't', head: 'h', base: 'b', keys: [] };
  assert.deepEqual(pr.diff(merged, merged), [], 'no change, no event');
});

test('the type is registered as a quiet singleton that never notifies', () => {
  const t = BUILTIN_TYPES['status-refresh'];
  assert.ok(t && t.singleton && t.notifies === 'never' && t.backoff === false && t.network === false && t.slowInQuiet);
  assert.throws(() => refresh.validate('/nonexistent/status'), /status directory/);
  assert.equal(readFileSync(new URL('../playbooks/event-types/status-refresh.md', import.meta.url), 'utf8').startsWith('# Event type: status-refresh'), true);
});

test('the stored PR snapshot is refreshed by the idle tick once it is over 10 minutes old, then not again for 10 minutes', () => {
  const r = rig();
  run(r, 9 * 60);
  assert.deepEqual(r.snaps, [], 'a snapshot taken at the start is fresh for 10 minutes');
  run(r, 2 * 60);
  assert.equal(r.snaps.length, 1);
  assert.equal((r.snaps[0] as number) - T0, 10 * 60 * SEC + 0, 'the first check at or past the 10 minute mark');
  run(r, 8 * 60);
  assert.equal(r.snaps.length, 1, 'throttled: one search per 10 minutes, whatever else wakes the check');
  r.set({ sig: 'b', marker: r.at() });
  run(r, 30);
  assert.equal(r.snaps.length, 1, 'a ledger write or PR-dirty marker does not trigger an extra search');
  run(r, 60);
  assert.equal(r.snaps.length, 2);
});

test('a snapshot another process just wrote (the greeting run) counts, so the loop does not search again', () => {
  const r = rig();
  r.set({ snapAt: T0 - 11 * 60 * SEC });
  r.step(30);
  assert.equal(r.snaps.length, 1);
  r.set({ snapAt: r.at() });
  run(r, 9 * 60);
  assert.equal(r.snaps.length, 1);
});

test('a failed snapshot search is reported once as a non-actionable event, retried after 10 minutes, and never throws', () => {
  const r = rig();
  r.set({ snapAt: 0, snapFail: 'gh api graphql failed: HTTP 502' });
  const s1 = r.step(30);
  assert.equal(r.snaps.length, 1);
  assert.equal(s1.snapshotError, 'gh api graphql failed: HTTP 502');
  assert.deepEqual(refresh.diff(null, s1), [{ summary: 'PR snapshot refresh failed: gh api graphql failed: HTTP 502', actionable: false }]);
  run(r, 9 * 60);
  assert.equal(r.snaps.length, 1, 'a failure waits the full 10 minutes too, so a down GitHub is not hammered');
  const s2 = r.step(60);
  assert.equal(r.snaps.length, 2);
  assert.deepEqual(refresh.diff(s1, s2), [], 'the same failure is not reported twice');
  r.set({ snapFail: '' });
  run(r, 11 * 60);
  const ok = r.step(30);
  assert.equal(ok.snapshotError, '');
});

test('no snapshot search runs in quiet hours, and one runs on the first waking check', () => {
  const r = rig();
  r.set({ snapAt: 0, quiet: true });
  run(r, 30 * 60);
  assert.deepEqual(r.snaps, []);
  r.set({ quiet: false });
  r.step(30);
  assert.equal(r.snaps.length, 1);
});
