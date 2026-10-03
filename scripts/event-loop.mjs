#!/usr/bin/env node
/**
 * event-loop.mjs: one loop for every "wake me when X happens" watch, so a session never runs N ad-hoc watchers.
 *
 *   event-loop.mjs add --id <id> --type <type> --target <t> [--done-when <rule>] [--report <text>] [--ttl-hours N] [--interval S] [--notify | --no-notify] [--notify-overnight]
 *   event-loop.mjs list [--json] | remove <id> | digest [--peek]
 *   event-loop.mjs run [--once] [--interval N]
 *
 * check(target, ctx) gets ctx.watch and ctx.prev (the state it returned last time, null on the first check).
 * A type may export `retired(watch, ctx)` to delete its per-watch files when the watch retires or is removed.
 * Each tick runs every live watch's type checker (scripts/event-types/<type>.mjs), compares the new state with
 * the stored one, and records an event only when the type's diff() reports one. Events go to a digest file;
 * `run` prints the digest and exits 10 as soon as one is actionable, so the caller (a cheap model) wakes the
 * orchestrator only then. Watches retire when their type says they are done or they pass `expires`.
 * Each type declares `interval` (default seconds between checks) and `network` (false only for local types);
 * a watch may override the interval with `add --interval S`. The loop checks only watches that are due and sleeps
 * until the earliest is due. Floors, enforced in lib/cadence.ts: 120s for network types, 30s for local ones.
 * Only watches added with `--notify` (reminders by default, inbox never) are sent to `notify_command`.
 * Cadence is lib/cadence.ts (floors, back-off, quiet hours). Settings are in local-config.mjs (event_dir, notify_command).
 *
 * Exit codes: 0 nothing actionable, 10 actionable events (stdout has the digest), 3 quiet-hours stop, 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EVENT_DIR, INBOX_COMMAND, NOTIFY_COMMAND, WATCH_MAX_INTERVAL, WATCH_MIN_INTERVAL, WATCH_QUIET_HOURS, WATCH_QUIET_HOURS_MODE,
  WATCH_LOCAL_FLOOR, WATCH_NETWORK_FLOOR, WATCH_QUIET_WEEKENDS, WATCH_TYPE_INTERVALS, WATCH_TZ,
} from './local-config.mjs';
import { SLOW_QUIET_SECONDS, nextInterval, watchInterval } from './lib/cadence.ts';
import { notify, notifyChoice, oneLine, watchNotifies } from './lib/notify.ts';
import { acquireLock, addWatch, appendDigest, listWatches, loadState, readDigest, removeWatch, saveState } from './lib/watch-registry.ts';

export const EXIT = { ok: 0, usage: 2, quietStop: 3, actionable: 10 };
const EVENT_HISTORY_MS = 6 * 3600 * 1000;
const FAILURES_BEFORE_EVENT = 3;
const DIGEST_SUMMARY = 300;

const cadenceConfig = (pinned) => ({
  minInterval: WATCH_MIN_INTERVAL, maxInterval: WATCH_MAX_INTERVAL, quietHours: WATCH_QUIET_HOURS, quietMode: WATCH_QUIET_HOURS_MODE,
  quietWeekends: WATCH_QUIET_WEEKENDS, tz: WATCH_TZ, pinned,
  networkFloor: WATCH_NETWORK_FLOOR, localFloor: WATCH_LOCAL_FLOOR, typeIntervals: WATCH_TYPE_INTERVALS,
});

/** Seconds until a watch is due again: its own --interval, else the loop-wide pin, else its type's. The floor is applied inside. */
const intervalFor = (watch, { types, config, now, recentEvents }) => watchInterval({
  type: watch.type, spec: types[watch.type], override: watch.interval ?? config.pinned, now, recentEvents, config,
}).seconds;

/** Runs a command and returns { status, stdout }; never throws on a non-zero exit (gh uses them for "pending"). */
export const defaultRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** In quiet hours a watch still runs if it is `notify_overnight`, or its type is `slowInQuiet` and quiet_hours_mode is `slow` (then at SLOW_QUIET_SECONDS or slower). */
const slowOnly = (watch, types, config) => !watch.notify_overnight && config.quietMode === 'slow' && types[watch.type]?.slowInQuiet === true;
const runsInQuiet = (watch, types, config) => watch.notify_overnight || slowOnly(watch, types, config);

const newest = (times) => (times.length ? Math.max(...times) : 0);
const trimEvents = (times, now) => times.filter((t) => t === newest(times) || now - t < EVENT_HISTORY_MS);
const isDone = (type, state, watch) => (type.done ? type.done(state, watch) : state?.done === true);

/** Lets a type clean up what it keeps per watch (`retired(watch, ctx)`); cleanup is best effort and never blocks retirement. */
function onRetired(type, watch, ctx) {
  try { type?.retired?.(watch, ctx); } catch { /* a leftover file is not worth failing the tick */ }
}

/** Checks one watch. Returns { events, state?, retire? } where each event is { summary, actionable? }. */
function checkWatch(watch, prev, { types, ctx }) {
  const type = types[watch.type];
  if (!type) throw new Error(`unknown event type "${watch.type}"`);
  const next = type.check(watch.target, { ...ctx, watch, prev: prev?.state ?? null });
  const events = type.diff(prev?.state ?? null, next) ?? [];
  return { events, state: next, retire: isDone(type, next, watch) ? 'done' : '' };
}

/**
 * One pass over the due watches. Pure of sleeping and printing: returns { events, retired, skipped, waiting }.
 * A watch is due when its stored `nextDue` has passed (a new watch is due at once); `waiting` lists the rest.
 * `deps`: { dir, types, ctx, config, now, notifyCommand, notifyRun }. A watch outside quiet hours checks as usual;
 * during quiet hours only `notify_overnight` watches are checked or notified.
 */
export function tick(deps) {
  const { dir, types, ctx = {}, config = cadenceConfig(), now = Date.now(), notifyCommand = [], notifyRun } = deps;
  const state = loadState(dir);
  // Quiet means the clock says so, whatever quietMode does to the pace (`slow` never returns stop).
  const quiet = nextInterval({ now, recentEvents: state.events, config: { ...config, quietMode: 'stop' } }).stop === true;
  const retirements = [];
  const out = { events: [], retired: [], skipped: [], waiting: [] };
  const ran = [];
  for (const watch of listWatches(dir)) {
    const meta = state.watches[watch.id] ?? { errors: 0 };
    const make = (e) => ({ watch: watch.id, type: watch.type, at: new Date(now).toISOString(), summary: oneLine(e.summary, DIGEST_SUMMARY), actionable: e.actionable !== false, report: e.actionable === false ? '' : watch.report });
    const mayNotify = watchNotifies(watch, types[watch.type]) && (!quiet || watch.notify_overnight);
    const retire = (reason, events = []) => {
      retirements.push({ watch, reason });
      delete state.watches[watch.id];
      out.retired.push({ id: watch.id, reason });
      out.events.push(...events.map((e) => ({ ...make(e), mayNotify })));
    };
    if (Date.parse(watch.expires) <= now) { retire('expired', [{ summary: `watch expired before it finished (${watch.type} ${watch.target})` }]); continue; }
    if (quiet && !runsInQuiet(watch, types, config)) { out.skipped.push(watch.id); continue; }
    if ((state.watches[watch.id]?.nextDue ?? 0) > now) { out.waiting.push(watch.id); continue; }
    ran.push(watch);
    try {
      const r = checkWatch(watch, state.watches[watch.id], { types, ctx: { ...ctx, now } });
      out.events.push(...r.events.map((e) => ({ ...make(e), mayNotify })));
      state.watches[watch.id] = { state: r.state, errors: 0, checkedAt: new Date(now).toISOString() };
      if (r.retire) { retirements.push({ watch, reason: r.retire }); delete state.watches[watch.id]; out.retired.push({ id: watch.id, reason: r.retire }); }
    } catch (err) {
      // A failing check keeps its last good state; it speaks once, after a few failures in a row.
      meta.errors += 1;
      state.watches[watch.id] = { ...meta };
      if (meta.errors === FAILURES_BEFORE_EVENT) out.events.push({ ...make({ summary: `check keeps failing: ${err.message.split('\n')[0]}` }), mayNotify });
    }
  }
  state.events = trimEvents([...state.events, ...out.events.map(() => now)], now);
  // Next due time from the final event history, so a burst this tick keeps the watch at its pace instead of backing off.
  for (const watch of ran) {
    const seconds = intervalFor(watch, { types, config, now, recentEvents: state.events });
    if (state.watches[watch.id]) state.watches[watch.id].nextDue = now + (quiet && slowOnly(watch, types, config) ? Math.max(seconds, SLOW_QUIET_SECONDS) : seconds) * 1000;
  }
  // Digest first: a crash between the two repeats an event on the next tick instead of losing it.
  appendDigest(dir, out.events.map(({ mayNotify, ...e }) => e));
  saveState(dir, state);
  // Tombstones last: a crash before this leaves the watch live, so the next tick retires it again instead of losing its final event.
  for (const { watch, reason } of retirements) { removeWatch(dir, watch.id, reason, now); onRetired(types[watch.type], watch, { ...ctx, dir }); }
  notify(out.events.filter((e) => e.actionable && e.mayNotify), notifyCommand, notifyRun);
  out.events = out.events.map(({ mayNotify, ...e }) => e);
  return out;
}

/**
 * Seconds to wait before the next tick: until the earliest watch is due, or { stop: true, until, tz } in quiet hours
 * with no overnight watch. In quiet hours only overnight watches count, and they run on their own clock.
 */
export function pace({ dir, types = {}, config = cadenceConfig(), now = Date.now() }) {
  const { events, watches: checked } = loadState(dir);
  const quiet = nextInterval({ now, recentEvents: events, config: { ...config, quietMode: 'stop' } }).stop === true;
  const live = listWatches(dir).filter((w) => !quiet || runsInQuiet(w, types, config));
  if (!live.length) return nextInterval({ now, recentEvents: events, config });
  const dueAt = (w) => checked[w.id]?.nextDue ?? now;
  const first = live.reduce((a, w) => (dueAt(w) < dueAt(a) ? w : a));
  return { seconds: Math.max(1, Math.ceil((dueAt(first) - now) / 1000)), reason: `${first.id} (${first.type}) is due next` };
}

/** The digest as compact lines, actionable first. Empty string when there is nothing. */
export const formatDigest = (events) => [...events].sort((a, b) => Number(b.actionable) - Number(a.actionable))
  .map((e) => `${e.actionable ? 'ACTION' : 'info'} ${e.watch} (${e.type}): ${e.summary}${e.report && e.actionable ? ` | report: ${e.report}` : ''}`).join('\n');

function finish(dir) {
  // Peek first: info-only events stay for the next actionable batch instead of vanishing.
  if (!readDigest(dir).some((e) => e.actionable)) return false;
  console.log(formatDigest(readDigest(dir, { consume: true })));
  return true;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function run({ dir, types, once, pinned }) {
  const ctx = { run: defaultRun, config: { inboxCommand: INBOX_COMMAND }, dir };
  for (;;) {
    if (!listWatches(dir).length) { console.log('no watches registered'); return EXIT.ok; }
    tick({ dir, types, ctx, config: cadenceConfig(pinned), notifyCommand: NOTIFY_COMMAND });
    if (finish(dir)) return EXIT.actionable;
    const next = pace({ dir, types, config: cadenceConfig(pinned) });
    if (next.stop) { console.log(`QUIET-HOURS stop until ${next.until} ${next.tz}`); return EXIT.quietStop; }
    if (once) { console.log('no actionable events'); return EXIT.ok; }
    console.error(`next check in ${next.seconds}s (${next.reason})`);
    await sleep(next.seconds);
  }
}

const OPTIONS = {
  id: { type: 'string' }, type: { type: 'string' }, target: { type: 'string' }, 'done-when': { type: 'string' }, report: { type: 'string' },
  'ttl-hours': { type: 'string' }, 'notify-overnight': { type: 'boolean' }, notify: { type: 'boolean' }, 'no-notify': { type: 'boolean' }, json: { type: 'boolean' }, peek: { type: 'boolean' },
  once: { type: 'boolean' }, interval: { type: 'string' },
};

/** Overlay-added types for cleanup on `remove`; a broken overlay yields none, since removal must still work. */
async function loadOverlayTypeQuietly() {
  try { return await (await import('./event-types/index.ts')).loadConfiguredTypes(); } catch { return {}; }
}

/** The type registered under `name` (built-in or overlay), or undefined. `add` of an unknown type is allowed; its checks then fail loudly. */
const typeNamed = async (name) => (await import('./event-types/index.ts')).BUILTIN_TYPES[name] ?? (await loadOverlayTypeQuietly())[name];

async function main(argv) {
  const dir = EVENT_DIR;
  const usage = (msg) => { console.error(`event-loop: ${msg}`); return EXIT.usage; };
  try {
    const { values: v, positionals: [cmd, arg] } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (cmd === 'add') {
      const ttl = v['ttl-hours'] === undefined ? undefined : Number(v['ttl-hours']) * 3600 * 1000;
      if (ttl !== undefined && !(ttl > 0)) return usage('--ttl-hours needs a positive number');
      const type = await typeNamed(v.type);
      const now = Date.now();
      type?.validate?.(v.target, { now, ttlMs: ttl });
      if (type?.singleton) {
        for (const w of listWatches(dir)) if ((await typeNamed(w.type)) === type) throw new Error(`watch "${w.id}" already runs ${v.type}${w.type === v.type ? '' : ` (as ${w.type})`}; keep exactly one`);
      }
      const w = addWatch(dir, { id: v.id, type: v.type, target: v.target, done_when: v['done-when'], report: v.report, ttlMs: ttl ?? type?.defaultTtlMs?.(v.target, now), notify_overnight: v['notify-overnight'], interval: v.interval, notify: notifyChoice(type, { notify: v.notify, noNotify: v['no-notify'] }) }, now);
      console.log(`added ${w.id} (${w.type} ${w.target}), expires ${w.expires}`);
    } else if (cmd === 'list') {
      const ws = listWatches(dir);
      console.log(v.json ? JSON.stringify(ws) : ws.map((w) => `${w.id}\t${w.type}\t${w.target}\texpires ${w.expires}`).join('\n') || 'no watches registered');
    } else if (cmd === 'remove') {
      const watch = listWatches(dir).find((w) => w.id === arg);
      console.log(removeWatch(dir, arg, 'removed by user') ? `removed ${arg}` : `no live watch ${arg}`);
      if (watch) onRetired((await import('./event-types/index.ts')).BUILTIN_TYPES[watch.type] ?? (await loadOverlayTypeQuietly())[watch.type], watch, { dir });
    } else if (cmd === 'digest') {
      console.log(formatDigest(readDigest(dir, { consume: !v.peek })) || 'digest is empty');
    } else if (cmd === 'run') {
      const pinned = v.interval === undefined ? undefined : Number(v.interval);
      if (pinned !== undefined && !(Number.isFinite(pinned) && pinned > 0)) return usage('--interval needs a positive number of seconds');
      const { loadConfiguredTypes } = await import('./event-types/index.ts');
      const types = await loadConfiguredTypes();
      acquireLock(dir);
      return await run({ dir, types, once: v.once, pinned });
    } else return usage('commands: add | list | remove <id> | digest | run [--once]');
  } catch (err) {
    return usage(err.message);
  }
  return EXIT.ok;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
