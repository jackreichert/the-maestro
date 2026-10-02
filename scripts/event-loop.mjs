#!/usr/bin/env node
/**
 * event-loop.mjs: one loop for every "wake me when X happens" watch, so a session never runs N ad-hoc watchers.
 *
 *   event-loop.mjs add --id <id> --type <type> --target <t> [--done-when <rule>] [--report <text>] [--ttl-hours N] [--notify-overnight]
 *   event-loop.mjs list [--json] | remove <id> | digest [--peek]
 *   event-loop.mjs run [--once] [--interval N]
 *
 * Each tick runs every live watch's type checker (scripts/event-types/<type>.mjs), compares the new state with
 * the stored one, and records an event only when the type's diff() reports one. Events go to a digest file;
 * `run` prints the digest and exits 10 as soon as one is actionable, so the caller (a cheap model) wakes the
 * orchestrator only then. Watches retire when their type says they are done or they pass `expires`.
 * Cadence is lib/cadence.mjs (floor 300s, quiet hours). Settings are in local-config.mjs (event_dir, notify_command).
 *
 * Exit codes: 0 nothing actionable, 10 actionable events (stdout has the digest), 3 quiet-hours stop, 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EVENT_DIR, INBOX_COMMAND, NOTIFY_COMMAND, WATCH_MAX_INTERVAL, WATCH_MIN_INTERVAL, WATCH_QUIET_HOURS, WATCH_QUIET_HOURS_MODE,
  WATCH_QUIET_WEEKENDS, WATCH_TZ,
} from './local-config.mjs';
import { nextInterval } from './lib/cadence.mjs';
import { notify, oneLine } from './lib/notify.mjs';
import { acquireLock, addWatch, appendDigest, listWatches, loadState, readDigest, removeWatch, saveState } from './lib/watch-registry.mjs';

export const EXIT = { ok: 0, usage: 2, quietStop: 3, actionable: 10 };
const EVENT_HISTORY_MS = 6 * 3600 * 1000;
const FAILURES_BEFORE_EVENT = 3;
const DIGEST_SUMMARY = 300;

const cadenceConfig = (pinned) => ({
  minInterval: WATCH_MIN_INTERVAL, maxInterval: WATCH_MAX_INTERVAL, quietHours: WATCH_QUIET_HOURS, quietMode: WATCH_QUIET_HOURS_MODE,
  quietWeekends: WATCH_QUIET_WEEKENDS, tz: WATCH_TZ, pinned,
});

/** Runs a command and returns { status, stdout }; never throws on a non-zero exit (gh uses them for "pending"). */
export const defaultRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const newest = (times) => (times.length ? Math.max(...times) : 0);
const trimEvents = (times, now) => times.filter((t) => t === newest(times) || now - t < EVENT_HISTORY_MS);
const isDone = (type, state, watch) => (type.done ? type.done(state, watch) : state?.done === true);

/** Checks one watch. Returns { events, state?, retire? } where each event is { summary, actionable? }. */
function checkWatch(watch, prev, { types, ctx }) {
  const type = types[watch.type];
  if (!type) throw new Error(`unknown event type "${watch.type}"`);
  const next = type.check(watch.target, { ...ctx, watch });
  const events = type.diff(prev?.state ?? null, next) ?? [];
  return { events, state: next, retire: isDone(type, next, watch) ? 'done' : '' };
}

/**
 * One pass over the live watches. Pure of sleeping and printing: returns { events, retired, skipped }.
 * `deps`: { dir, types, ctx, config, now, notifyCommand, notifyRun }. A watch outside quiet hours checks as usual;
 * during quiet hours only `notify_overnight` watches are checked or notified.
 */
export function tick(deps) {
  const { dir, types, ctx = {}, config = cadenceConfig(), now = Date.now(), notifyCommand = [], notifyRun } = deps;
  const state = loadState(dir);
  const quiet = Boolean(nextInterval({ now, recentEvents: state.events, config }).stop);
  const out = { events: [], retired: [], skipped: [] };
  for (const watch of listWatches(dir)) {
    const meta = state.watches[watch.id] ?? { errors: 0 };
    const make = (e) => ({ watch: watch.id, type: watch.type, at: new Date(now).toISOString(), summary: oneLine(e.summary, DIGEST_SUMMARY), actionable: e.actionable !== false, report: e.actionable === false ? '' : watch.report });
    const mayNotify = !quiet || watch.notify_overnight;
    const retire = (reason, events = []) => {
      removeWatch(dir, watch.id, reason, now);
      delete state.watches[watch.id];
      out.retired.push({ id: watch.id, reason });
      out.events.push(...events.map((e) => ({ ...make(e), mayNotify })));
    };
    if (Date.parse(watch.expires) <= now) { retire('expired', [{ summary: `watch expired before it finished (${watch.type} ${watch.target})` }]); continue; }
    if (quiet && !watch.notify_overnight) { out.skipped.push(watch.id); continue; }
    try {
      const r = checkWatch(watch, state.watches[watch.id], { types, ctx: { ...ctx, now } });
      out.events.push(...r.events.map((e) => ({ ...make(e), mayNotify })));
      state.watches[watch.id] = { state: r.state, errors: 0, checkedAt: new Date(now).toISOString() };
      if (r.retire) { removeWatch(dir, watch.id, r.retire, now); delete state.watches[watch.id]; out.retired.push({ id: watch.id, reason: r.retire }); }
    } catch (err) {
      // A failing check keeps its last good state; it speaks once, after a few failures in a row.
      meta.errors += 1;
      state.watches[watch.id] = { ...meta };
      if (meta.errors === FAILURES_BEFORE_EVENT) out.events.push({ ...make({ summary: `check keeps failing: ${err.message.split('\n')[0]}` }), mayNotify });
    }
  }
  state.events = trimEvents([...state.events, ...out.events.map(() => now)], now);
  // Digest first: a crash between the two repeats an event on the next tick instead of losing it.
  appendDigest(dir, out.events.map(({ mayNotify, ...e }) => e));
  saveState(dir, state);
  notify(out.events.filter((e) => e.actionable && e.mayNotify), notifyCommand, notifyRun);
  out.events = out.events.map(({ mayNotify, ...e }) => e);
  return out;
}

/** Seconds to wait before the next tick, or { stop: true, until, tz } in quiet hours with no overnight watch. */
export function pace({ dir, config = cadenceConfig(), now = Date.now() }) {
  const events = loadState(dir).events;
  const next = nextInterval({ now, recentEvents: events, config });
  if (next.stop && listWatches(dir).some((w) => w.notify_overnight)) return nextInterval({ now, recentEvents: events, config: { ...config, quietHours: 'off' } });
  return next;
}

/** The digest as compact lines, actionable first. Empty string when there is nothing. */
export const formatDigest = (events) => [...events].sort((a, b) => Number(b.actionable) - Number(a.actionable))
  .map((e) => `${e.actionable ? 'ACTION' : 'info'} ${e.watch} (${e.type}): ${e.summary}${e.report && e.actionable ? ` | report: ${e.report}` : ''}`).join('\n');

function finish(dir) {
  const events = readDigest(dir, { consume: true });
  if (!events.some((e) => e.actionable)) return false;
  console.log(formatDigest(events));
  return true;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function run({ dir, types, once, pinned }) {
  const ctx = { run: defaultRun, config: { inboxCommand: INBOX_COMMAND }, dir };
  for (;;) {
    if (!listWatches(dir).length) { console.log('no watches registered'); return EXIT.ok; }
    tick({ dir, types, ctx, config: cadenceConfig(pinned), notifyCommand: NOTIFY_COMMAND });
    if (finish(dir)) return EXIT.actionable;
    const next = pace({ dir, config: cadenceConfig(pinned) });
    if (next.stop) { console.log(`QUIET-HOURS stop until ${next.until} ${next.tz}`); return EXIT.quietStop; }
    if (once) { console.log('no actionable events'); return EXIT.ok; }
    console.error(`next check in ${next.seconds}s (${next.reason})`);
    await sleep(next.seconds);
  }
}

const OPTIONS = {
  id: { type: 'string' }, type: { type: 'string' }, target: { type: 'string' }, 'done-when': { type: 'string' }, report: { type: 'string' },
  'ttl-hours': { type: 'string' }, 'notify-overnight': { type: 'boolean' }, json: { type: 'boolean' }, peek: { type: 'boolean' },
  once: { type: 'boolean' }, interval: { type: 'string' },
};

async function main(argv) {
  const dir = EVENT_DIR;
  const usage = (msg) => { console.error(`event-loop: ${msg}`); return EXIT.usage; };
  try {
    const { values: v, positionals: [cmd, arg] } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (cmd === 'add') {
      const ttl = v['ttl-hours'] === undefined ? undefined : Number(v['ttl-hours']) * 3600 * 1000;
      if (ttl !== undefined && !(ttl > 0)) return usage('--ttl-hours needs a positive number');
      const w = addWatch(dir, { id: v.id, type: v.type, target: v.target, done_when: v['done-when'], report: v.report, ttlMs: ttl, notify_overnight: v['notify-overnight'] });
      console.log(`added ${w.id} (${w.type} ${w.target}), expires ${w.expires}`);
    } else if (cmd === 'list') {
      const ws = listWatches(dir);
      console.log(v.json ? JSON.stringify(ws) : ws.map((w) => `${w.id}\t${w.type}\t${w.target}\texpires ${w.expires}`).join('\n') || 'no watches registered');
    } else if (cmd === 'remove') {
      console.log(removeWatch(dir, arg, 'removed by user') ? `removed ${arg}` : `no live watch ${arg}`);
    } else if (cmd === 'digest') {
      console.log(formatDigest(readDigest(dir, { consume: !v.peek })) || 'digest is empty');
    } else if (cmd === 'run') {
      const pinned = v.interval === undefined ? undefined : Number(v.interval);
      if (pinned !== undefined && !(pinned > 0)) return usage('--interval needs a positive number of seconds');
      const { TYPES } = await import('./event-types/index.mjs');
      acquireLock(dir);
      return await run({ dir, types: TYPES, once: v.once, pinned });
    } else return usage('commands: add | list | remove <id> | digest | run [--once]');
  } catch (err) {
    return usage(err.message);
  }
  return EXIT.ok;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
