#!/usr/bin/env node
/**
 * event-loop.ts: one loop for every "wake me when X happens" watch, so a session never runs N ad-hoc watchers.
 *
 *   event-loop.ts add --id <id> --type <type> --target <t> [--done-when <rule>] [--report <text>] [--ttl-hours N] [--interval S] [--notify | --no-notify] [--notify-overnight]
 *   event-loop.ts list [--json] | remove <id> | digest [--peek]
 *   event-loop.ts run [--once] [--interval N]
 *   event-loop.ts digest-wait [--timeout-hours N] | digests [--unseen] [--mark-seen]
 *
 * check(target, ctx) gets ctx.watch and ctx.prev (the state it returned last time, null on the first check).
 * A type may export `retired(watch, ctx)` to delete its per-watch files when the watch retires or is removed.
 * Each tick runs every live watch's type checker (scripts/event-types/<type>.ts), compares the new state with
 * the stored one, and records an event only when the type's diff() reports one. Events go to a digest file;
 * `run` prints the digest and exits 10 as soon as one is actionable, so the caller (a cheap model) wakes the
 * orchestrator only then. Watches retire when their type says they are done or they pass `expires`; a watch of a standing type (`renews`) added without --ttl-hours has its `expires` pushed out instead.
 * Each type declares `interval` (default seconds between checks) and `network` (false only for local types);
 * a watch may override the interval with `add --interval S`. The loop checks only watches that are due and sleeps
 * until the earliest is due. Floors, enforced in lib/cadence.ts: 120s for network types, 30s for local ones.
 * Only watches added with `--notify` (reminders by default, inbox never) are sent to `notify_command`.
 * Cadence is lib/cadence.ts (floors, back-off, quiet hours). Settings are in local-config.ts (event_dir, notify_command).
 *
 * `digest-wait` blocks until the supervisor (loop-supervisor.ts) has saved an unseen digest, prints it, marks it seen and
 * exits 10, so a session that cannot hold the loop lock is still woken; it exits 0 quietly at the timeout (default 6h).
 *
 * Exit codes: 0 nothing actionable, 10 actionable events (stdout has the digest), 3 quiet-hours stop, 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EVENT_DIR, INBOX_COMMAND, NOTIFY_COMMAND, WATCH_MAX_INTERVAL, WATCH_MIN_INTERVAL, WATCH_QUIET_HOURS, WATCH_QUIET_HOURS_MODE,
  WATCH_LOCAL_FLOOR, WATCH_NETWORK_FLOOR, WATCH_QUIET_WEEKENDS, WATCH_TYPE_INTERVALS, WATCH_TZ, LEDGER_ROOT, CONTAINER_PROJECT,
} from './local-config.ts';
import { claimDigests, digestBody, digestDir, unseenDigests } from './lib/digest-store.ts';
import type { CadenceConfig, Interval, Stop } from './lib/cadence.ts';
import { SLOW_QUIET_SECONDS, nextInterval, watchInterval } from './lib/cadence.ts';
import type { TypeRegistry } from './event-types/index.ts';
import type { CheckContext, DigestEvent, EventType, LoopContext, Run, RunResult, Watch, WatchEvent, WatchState } from './lib/types.ts';
import type { NotifyRun } from './lib/notify.ts';
import { notify, notifyChoice, oneLine, watchNotifies } from './lib/notify.ts';
import { DEFAULT_TTL_MS, acquireLock, addWatch, appendDigest, listWatches, loadState, readDigest, removeWatch, renewWatch, saveState } from './lib/watch-registry.ts';

/** What `tick` is given. Only `dir` and `types` are required. */
export interface TickDeps {
  dir: string;
  types: TypeRegistry;
  ctx?: LoopContext;
  config?: CadenceConfig;
  now?: number;
  notifyCommand?: string[];
  notifyRun?: NotifyRun;
}

/** What one tick did: the digest events, retired watches, ids skipped in quiet hours and ids not yet due. */
export interface TickResult {
  events: DigestEvent[];
  retired: { id: string; reason: string }[];
  skipped: string[];
  waiting: string[];
}

/** An event as `tick` builds it: `mayNotify` is dropped before the digest and the result. */
type PendingEvent = DigestEvent & { mayNotify: boolean };

export const EXIT = { ok: 0, usage: 2, quietStop: 3, actionable: 10 };
const EVENT_HISTORY_MS = 6 * 3600 * 1000;
const FAILURES_BEFORE_EVENT = 3;
const DIGEST_SUMMARY = 300;

const cadenceConfig = (pinned?: number): CadenceConfig => ({
  minInterval: WATCH_MIN_INTERVAL, maxInterval: WATCH_MAX_INTERVAL, quietHours: WATCH_QUIET_HOURS, quietMode: WATCH_QUIET_HOURS_MODE,
  quietWeekends: WATCH_QUIET_WEEKENDS, tz: WATCH_TZ, pinned,
  networkFloor: WATCH_NETWORK_FLOOR, localFloor: WATCH_LOCAL_FLOOR, typeIntervals: WATCH_TYPE_INTERVALS,
});

/** Seconds until a watch is due again: its own --interval, else the loop-wide pin, else its type's. The floor is applied inside. */
const intervalFor = (watch: Watch, { types, config, now, recentEvents }: { types: TypeRegistry; config: CadenceConfig; now: number; recentEvents: number[] }): number => watchInterval({
  type: watch.type, spec: types[watch.type], override: watch.interval ?? config.pinned, now, recentEvents, config,
}).seconds;

/** Runs a command and returns { status, stdout }; never throws on a non-zero exit (gh uses them for "pending"). */
export const defaultRun: Run = (cmd, args): RunResult => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** In quiet hours a watch still runs if it is `notify_overnight`, or its type is `slowInQuiet` and quiet_hours_mode is `slow` (then at SLOW_QUIET_SECONDS or slower). */
const slowOnly = (watch: Watch, types: TypeRegistry, config: CadenceConfig): boolean => !watch.notify_overnight && config.quietMode === 'slow' && types[watch.type]?.slowInQuiet === true;
const runsInQuiet = (watch: Watch, types: TypeRegistry, config: CadenceConfig): boolean => watch.notify_overnight || slowOnly(watch, types, config);

const newest = (times: number[]): number => (times.length ? Math.max(...times) : 0);
const trimEvents = (times: number[], now: number): number[] => times.filter((t) => t === newest(times) || now - t < EVENT_HISTORY_MS);
const isDone = (type: EventType, state: unknown, watch: Watch): boolean => (type.done ? type.done(state, watch) : (state as { done?: unknown } | null | undefined)?.done === true);

/** Lets a type clean up what it keeps per watch (`retired(watch, ctx)`); cleanup is best effort and never blocks retirement. */
function onRetired(type: EventType | undefined, watch: Watch, ctx: Partial<LoopContext>): void {
  try { type?.retired?.(watch, ctx as CheckContext); } catch { /* a leftover file is not worth failing the tick */ }
}

/** Checks one watch. Returns { events, state?, retire? } where each event is { summary, actionable? }. */
function checkWatch(watch: Watch, prev: WatchState | undefined, { types, ctx }: { types: TypeRegistry; ctx: LoopContext & { now: number } }): { events: WatchEvent[]; state: unknown; retire: string } {
  const type = types[watch.type];
  if (!type) throw new Error(`unknown event type "${watch.type}"`);
  const next = type.check(watch.target, { ...ctx, watch, prev: prev?.state ?? null });
  const events = type.diff(prev?.state ?? null, next) ?? [];
  return { events, state: next, retire: isDone(type, next, watch) ? 'done' : '' };
}

/**
 * A standing watch (marked `renew` at add, its type has `renews`) with under half its default TTL left gets a fresh full TTL from `now`, past expiry included:
 * a loop that was down for a day must not retire the watches it exists to run. Returns the watch with its new expiry, or the same one.
 */
function renewed(dir: string, watch: Watch, type: EventType | undefined, now: number): Watch {
  if (!watch.renew || !type?.renews) return watch;
  const asked = type.defaultTtlMs?.(watch.target, now);
  const ttl = asked !== undefined && Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TTL_MS;
  if (Date.parse(watch.expires) - now >= ttl / 2) return watch;
  return renewWatch(dir, watch.id, now + ttl, now) ? { ...watch, expires: new Date(now + ttl).toISOString() } : watch;
}

/**
 * One pass over the due watches. Pure of sleeping and printing: returns { events, retired, skipped, waiting }.
 * A watch is due when its stored `nextDue` has passed (a new watch is due at once); `waiting` lists the rest.
 * `deps`: { dir, types, ctx, config, now, notifyCommand, notifyRun }. A watch outside quiet hours checks as usual;
 * during quiet hours only `notify_overnight` watches are checked or notified.
 */
export function tick(deps: TickDeps): TickResult {
  const { dir, types, ctx = {} as LoopContext, config = cadenceConfig(), now = Date.now(), notifyCommand = [], notifyRun } = deps;
  const state = loadState(dir);
  // Quiet means the clock says so, whatever quietMode does to the pace (`slow` never returns stop).
  const quiet = 'stop' in nextInterval({ now, recentEvents: state.events, config: { ...config, quietMode: 'stop' } });
  const retirements: { watch: Watch; reason: string }[] = [];
  const out: Omit<TickResult, 'events'> & { events: PendingEvent[] } = { events: [], retired: [], skipped: [], waiting: [] };
  const ran: Watch[] = [];
  for (const listed of listWatches(dir)) {
    const watch = renewed(dir, listed, types[listed.type], now);
    const meta = state.watches[watch.id] ?? { errors: 0 };
    const make = (e: WatchEvent): DigestEvent => ({ watch: watch.id, type: watch.type, at: new Date(now).toISOString(), summary: oneLine(e.summary, DIGEST_SUMMARY), actionable: e.actionable !== false, report: e.actionable === false ? '' : watch.report });
    const mayNotify = watchNotifies(watch, types[watch.type]) && (!quiet || watch.notify_overnight);
    const retire = (reason: string, events: WatchEvent[] = []): void => {
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
      if (meta.errors === FAILURES_BEFORE_EVENT) out.events.push({ ...make({ summary: `check keeps failing: ${errorMessage(err).split('\n')[0]}` }), mayNotify });
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
  return { ...out, events: out.events.map(({ mayNotify, ...e }) => e) };
}

/**
 * Seconds to wait before the next tick: until the earliest watch is due, or { stop: true, until, tz } in quiet hours
 * with no overnight watch. In quiet hours only overnight watches count, and they run on their own clock.
 */
export function pace({ dir, types = {}, config = cadenceConfig(), now = Date.now() }: { dir: string; types?: TypeRegistry; config?: CadenceConfig; now?: number }): Interval | Stop {
  const { events, watches: checked } = loadState(dir);
  const quiet = 'stop' in nextInterval({ now, recentEvents: events, config: { ...config, quietMode: 'stop' } });
  const live = listWatches(dir).filter((w) => !quiet || runsInQuiet(w, types, config));
  if (!live.length) return nextInterval({ now, recentEvents: events, config });
  const dueAt = (w: Watch): number => checked[w.id]?.nextDue ?? now;
  const first = live.reduce((a, w) => (dueAt(w) < dueAt(a) ? w : a));
  return { seconds: Math.max(1, Math.ceil((dueAt(first) - now) / 1000)), reason: `${first.id} (${first.type}) is due next` };
}

/** The digest as compact lines, actionable first. Empty string when there is nothing. */
export const formatDigest = (events: DigestEvent[]): string => [...events].sort((a, b) => Number(b.actionable) - Number(a.actionable))
  .map((e) => `${e.actionable ? 'ACTION' : 'info'} ${e.watch} (${e.type}): ${e.summary}${e.report && e.actionable ? ` | report: ${e.report}` : ''}`).join('\n');

function finish(dir: string): boolean {
  // Peek first: info-only events stay for the next actionable batch instead of vanishing.
  if (!readDigest(dir).some((e) => e.actionable)) return false;
  console.log(formatDigest(readDigest(dir, { consume: true })));
  return true;
}

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

async function run({ dir, types, once, pinned }: { dir: string; types: TypeRegistry; once?: boolean; pinned?: number }): Promise<number> {
  const ctx = { run: defaultRun, config: { inboxCommand: INBOX_COMMAND }, dir };
  for (;;) {
    if (!listWatches(dir).length) { console.log('no watches registered'); return EXIT.ok; }
    tick({ dir, types, ctx, config: cadenceConfig(pinned), notifyCommand: NOTIFY_COMMAND });
    if (finish(dir)) return EXIT.actionable;
    const next = pace({ dir, types, config: cadenceConfig(pinned) });
    if ('stop' in next) { console.log(`QUIET-HOURS stop until ${next.until} ${next.tz}`); return EXIT.quietStop; }
    if (once) { console.log('no actionable events'); return EXIT.ok; }
    console.error(`next check in ${next.seconds}s (${next.reason})`);
    await sleep(next.seconds);
  }
}

/** Prints the unseen digests. With `claim`, they are first claimed (so no other waiter takes them) and marked seen only after printing: at-least-once. Returns whether anything was printed. */
function printUnseen(dir: string, claim: boolean): boolean {
  const taken = claim ? claimDigests(dir) : unseenDigests(dir).map((f) => ({ text: digestBody(f), finish: () => {} }));
  if (!taken.length) return false;
  console.log(taken.map((t) => t.text).join('\n'));
  taken.forEach((t) => t.finish());
  return true;
}

/** Blocks until an unseen digest is claimed (printed, then marked seen, exit 10) or the timeout passes (exit 0, silent). A waiter that loses a claim keeps waiting. */
async function digestWait(dir: string, timeoutMs: number, pollSeconds: number): Promise<number> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (printUnseen(dir, true)) return EXIT.actionable;
    if (Date.now() >= end) return EXIT.ok;
    await sleep(Math.min(pollSeconds, Math.max(0.05, (end - Date.now()) / 1000)));
  }
}

const OPTIONS = {
  'timeout-hours': { type: 'string' }, 'poll-seconds': { type: 'string' }, unseen: { type: 'boolean' }, 'mark-seen': { type: 'boolean' },
  id: { type: 'string' }, type: { type: 'string' }, target: { type: 'string' }, 'done-when': { type: 'string' }, report: { type: 'string' },
  'ttl-hours': { type: 'string' }, 'notify-overnight': { type: 'boolean' }, notify: { type: 'boolean' }, 'no-notify': { type: 'boolean' }, json: { type: 'boolean' }, peek: { type: 'boolean' },
  once: { type: 'boolean' }, interval: { type: 'string' },
} as const;

/** Overlay-added types for cleanup on `remove`; a broken overlay yields none, since removal must still work. */
async function loadOverlayTypeQuietly(): Promise<TypeRegistry> {
  try { return await (await import('./event-types/index.ts')).loadConfiguredTypes(); } catch { return {}; }
}

/** The type registered under `name` (built-in or overlay), or undefined. `add` of an unknown type is allowed; its checks then fail loudly. */
const typeNamed = async (name: string | undefined): Promise<EventType | undefined> => (name === undefined ? undefined : (await import('./event-types/index.ts')).BUILTIN_TYPES[name] ?? (await loadOverlayTypeQuietly())[name]);

async function main(argv: string[]): Promise<number> {
  const dir = EVENT_DIR;
  const usage = (msg: string): number => { console.error(`event-loop: ${msg}`); return EXIT.usage; };
  try {
    const { values: v, positionals: [cmd, arg] } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (cmd === 'add') {
      const ttl = v['ttl-hours'] === undefined ? undefined : Number(v['ttl-hours']) * 3600 * 1000;
      if (ttl !== undefined && !(ttl > 0)) return usage('--ttl-hours needs a positive number');
      const type = await typeNamed(v.type);
      const now = Date.now();
      // A missing --target reaches validate as undefined, as before; addWatch below rejects it.
      type?.validate?.(v.target as string, { now, ttlMs: ttl });
      if (type?.singleton) {
        for (const w of listWatches(dir)) if ((await typeNamed(w.type)) === type) throw new Error(`watch "${w.id}" already runs ${v.type}${w.type === v.type ? '' : ` (as ${w.type})`}; keep exactly one`);
      }
      const w = addWatch(dir, { id: v.id, type: v.type, target: v.target, done_when: v['done-when'], report: v.report, ttlMs: ttl ?? type?.defaultTtlMs?.(v.target as string, now), notify_overnight: v['notify-overnight'], interval: v.interval, notify: notifyChoice(type, { notify: v.notify, noNotify: v['no-notify'] }), renew: Boolean(type?.renews) && ttl === undefined }, now);
      console.log(`added ${w.id} (${w.type} ${w.target}), expires ${w.expires}`);
    } else if (cmd === 'list') {
      const ws = listWatches(dir);
      console.log(v.json ? JSON.stringify(ws) : ws.map((w) => `${w.id}\t${w.type}\t${w.target}\texpires ${w.expires}`).join('\n') || 'no watches registered');
    } else if (cmd === 'remove') {
      const watch = listWatches(dir).find((w) => w.id === arg);
      console.log(removeWatch(dir, String(arg), 'removed by user') ? `removed ${arg}` : `no live watch ${arg}`);
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
    } else if (cmd === 'digest-wait' || cmd === 'digests') {
      if (!LEDGER_ROOT) return usage('saved digests live under the ledger root; set LEDGER_ROOT (or ledger_root in the config)');
      const saved = digestDir(LEDGER_ROOT, CONTAINER_PROJECT);
      if (cmd === 'digests') { if (!printUnseen(saved, Boolean(v['mark-seen']))) console.log('no unseen digests'); return EXIT.ok; }
      const hours = v['timeout-hours'] === undefined ? 6 : Number(v['timeout-hours']);
      const poll = v['poll-seconds'] === undefined ? 5 : Number(v['poll-seconds']);
      if (!(hours > 0) || !(poll > 0)) return usage('--timeout-hours and --poll-seconds need positive numbers');
      return await digestWait(saved, hours * 3600 * 1000, poll);
    } else return usage('commands: add | list | remove <id> | digest | run [--once] | digest-wait | digests');
  } catch (err) {
    return usage(errorMessage(err));
  }
  return EXIT.ok;
}

/** The message of a caught value; `catch` binds `unknown`. */
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
