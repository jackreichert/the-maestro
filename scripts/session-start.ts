#!/usr/bin/env node
/**
 * session-start.ts: the first command of a session. Idempotent; it registers what is missing and reports the rest.
 *
 *   session-start.ts [--status-dir <dir>] [--project <name>]
 *
 * 1. Registers the `status-watch`, `status-refresh` and `whats-next` watches (target = the status directory) when no live watch of that type exists.
 *    It goes through `event-loop.ts add`, so each type's own validation, singleton rule and default TTL apply. A watch past its
 *    `expires` that the loop has not retired yet is removed first and registered again.
 * 2. Marks live watches of a standing type that lack the `renew` flag (see `repairStandingWatches`).
 * 3. Reports the status page's age (the mtime of The-Podium.md). A page older than 15 minutes means nothing is refreshing it.
 * 4. Reports `Podium web: down` when the footer link (`status_page_uri`, when it is an http loopback URL) does not answer a short local connect. Silent when the link is up or not an http URL.
 * 5. Reports the loop's heartbeat verdict (`Loop:`, silent when no loop is set up or required) and whether an event loop holds the lock. It never starts the loop: the launchd
 *    supervisor is the only runner (an in-session `run` is refused while it is installed). It prints one command to run with run_in_background, `events wait`, which blocks until
 *    an event for this window is in the inbox, so the session is woken by it. With no loop running it also says how the supervisor is restarted or installed.
 *
 * Exit 0 when nothing failed, 1 when a watch could not be registered (or the registry could not be read), 2 on a usage or configuration error (no status directory).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONTAINER_PROJECT, EVENT_DIR, LEDGER_ROOT, REPOST_NUDGE_ENABLED, STATUS_PAGE_URI_SETTING, statusDirFor, WATCH_TZ } from './local-config.ts';
import { podiumWebUrl } from './lib/status-page/links.ts';
import { PODIUM_FILE } from './lib/status-page/seen.ts';
import { listWatches, lockHolder, markStanding, removeWatch } from './lib/watch-registry.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import type { TypeRegistry } from './event-types/index.ts';
import type { Watch } from './lib/types.ts';
import { digestDir, drainDigests } from './lib/digest-store.ts';
import { liveLoopHealth } from './lib/loop-health-live.ts';
import { LABEL } from './lib/supervisor-state.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
/** The watches a session needs, keyed by the id used when one is missing. retro-due and repost-nudge are here so the periodic retro review and the repost nudge never depend on someone remembering to register it. */
export const NEEDED = [{ id: 'status-watch', type: 'status-watch' }, { id: 'status-refresh', type: 'status-refresh' }, { id: 'retro-due', type: 'retro-due' }, { id: 'repost-nudge', type: 'repost-nudge' }, { id: 'whats-next', type: 'whats-next' }] as const;
/** The refresh ticks every 10 minutes; a page this old has had at least one missed tick. */
export const STALE_MS = 15 * 60_000;

/** Everything the report reads from or does to the outside world; tests replace it. */
export interface StartDeps {
  now: number;
  tz: string;
  watches: () => Watch[];
  removeWatch: (id: string) => void;
  /** Registers one watch; ok false carries the reason. */
  addWatch: (id: string, type: string, statusDir: string) => { ok: boolean; message: string };
  /** Watch types that are switched off in the settings: not registered, and said so. Absent means none. */
  disabledTypes?: readonly string[];
  lockHolder: () => number | null;
  /** When the page was last written, or null when there is none. */
  pageWrittenAt: (statusDir: string) => number | null;
  /** The command that waits on the event inbox (`events wait`), ready to paste. The only command a session runs for the loop. */
  waitCommand: string;
  /** Marks live watches of a standing type that lack the flag; returns their ids. Absent where nothing repairs. */
  repairStanding?: () => string[];
  /** Takes every unseen digest (marking each seen after) and returns their texts; absent where there is no digest store. */
  drainDigests?: () => string[];
  /** The `Loop:` verdict line (heartbeat age, STALLED, DOWN...); empty or absent when there is nothing to say. */
  loopHealth?: () => string;
  /** The Podium web link and whether a connect to it succeeded; absent (or an empty url) where the footer link is not an http URL. */
  webProbe?: () => { url: string; up: boolean };
}

export interface StartReport { lines: string[]; failed: boolean }

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "4 min", "2 h 5 min", "3 days". */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return plural(Math.floor(min / 1440), 'day');
}

const clock = (at: number, tz: string): string => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at);

/** The line for a watch that was already there; a target other than the one this run resolved is called out, since it is a silent no-op otherwise. */
const existing = (id: string, w: Watch, statusDir: string): string =>
  `${id}: already registered (${w.id}, expires ${w.expires})${w.target === statusDir ? '' : `; WARNING its target is ${w.target}, not ${statusDir}: \`event-loop.ts remove ${w.id}\` and rerun to retarget`}`;

/** Registers the missing watches, then reports page age and loop state. Safe to run any number of times. */
export function sessionStart(statusDir: string, deps: StartDeps): StartReport {
  const lines: string[] = [];
  let failed = false;
  for (const need of NEEDED) {
    if (deps.disabledTypes?.includes(need.type)) { lines.push(`${need.id}: off in the settings, not registered`); continue; }
    const live = deps.watches().filter((w) => w.type === need.type);
    const current = live.find((w) => Date.parse(w.expires) > deps.now);
    if (current) { lines.push(existing(need.id, current, statusDir)); continue; }
    live.forEach((w) => deps.removeWatch(w.id));
    const added = deps.addWatch(need.id, need.type, statusDir);
    // A concurrent session start may have registered it between our read and our add: that is success, not failure.
    const raced = added.ok ? undefined : deps.watches().find((w) => w.type === need.type && Date.parse(w.expires) > deps.now);
    failed ||= !added.ok && !raced;
    lines.push(raced ? existing(need.id, raced, statusDir) : added.ok ? `${need.id}: registered (${added.message})` : `${need.id}: NOT registered (${added.message})`);
  }
  const repaired = deps.repairStanding?.() ?? [];
  if (repaired.length) lines.push(`Standing watches: marked ${repaired.join(', ')} as renewing (added before their type could renew, so they would have expired); the loop now keeps them alive`);
  const written = deps.pageWrittenAt(statusDir);
  if (written === null) lines.push(`Status page: none yet (no ${PODIUM_FILE} in ${statusDir}); run \`journal.ts podium\` once`);
  else {
    const age = deps.now - written;
    lines.push(`Status page: updated ${ageText(age)} ago (${clock(written, deps.tz)})${age > STALE_MS ? '; STALE, nothing is refreshing it until the loop runs' : ''}`);
  }
  const web = deps.webProbe?.();
  if (web?.url && !web.up) lines.push(`Podium web: down (nothing answers at ${web.url}); the page link in the footer will not open. Restart it: \`journal.ts web\``);
  const drained = deps.drainDigests?.() ?? [];
  if (drained.length) lines.push(`Unread digests (${drained.length}), shown once and now marked seen:`, ...drained);
  const health = deps.loopHealth?.().replace(/\*\*/g, '');
  if (health) lines.push(health);
  const holder = deps.lockHolder();
  lines.push(holder === null
    ? `Event loop: NOT RUNNING. No session starts it: the launchd supervisor is the only runner (restart: ${restartCommand()}; not installed yet: node scripts/install-loop-supervisor.ts). Events already in the inbox still reach you: wait on it with run_in_background: ${deps.waitCommand}`
    : `Event loop: running (pid ${holder}), the launchd supervisor's. Wait on the inbox with run_in_background: ${deps.waitCommand}`);
  return { lines, failed };
}

/**
 * Marks every live watch whose type `renews` but that carries no `renew` flag (the `prs` and `texts` watches predate the flag) so the loop
 * pushes their expiry out instead of retiring them. A watch added with an explicit --ttl-hours is not told apart from one added before
 * the flag existed, so it is marked too: a standing type is meant to stand. Returns the ids marked.
 */
export function repairStandingWatches(dir: string, types: TypeRegistry, now: number = Date.now()): string[] {
  return listWatches(dir).filter((w) => !w.renew && types[w.type]?.renews && markStanding(dir, w.id, now)).map((w) => w.id);
}

/** True when something accepts a TCP connection at the URL's host and port within `timeoutMs`. Runs a child so the check stays synchronous and can never hang the caller: the child is killed at the timeout. */
export function connects(url: string, timeoutMs = 1500): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const script = 'const s=require("node:net").connect({host:process.argv[1],port:+process.argv[2]});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1))';
  const r = spawnSync(process.execPath, ['-e', script, u.hostname, u.port || (u.protocol === 'https:' ? '443' : '80')], { timeout: timeoutMs + 500, killSignal: 'SIGKILL' });
  return r.status === 0;
}

/** The launchctl line that restarts the supervisor (printed, never run). */
const restartCommand = (): string => `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${LABEL}`;

const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The real world: `event-loop.ts add` for registration, the mtime of the page file, the lock file. */
export function realDeps(now: number = Date.now()): StartDeps {
  const loop = join(SCRIPTS, 'event-loop.ts');
  return {
    now,
    tz: WATCH_TZ,
    disabledTypes: REPOST_NUDGE_ENABLED ? [] : ['repost-nudge'],
    watches: () => listWatches(EVENT_DIR),
    removeWatch: (id) => { removeWatch(EVENT_DIR, id, 'expired, replaced at session start', now); },
    addWatch: (id, type, statusDir) => {
      const r = spawnSync(process.execPath, [loop, 'add', '--id', id, '--type', type, '--target', statusDir], { encoding: 'utf8', timeout: 30_000 });
      if (r.error || r.status === null) return { ok: false, message: r.error?.message ?? `event-loop.ts add was killed (${r.signal ?? 'no status'})` };
      const text = (r.status === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n').pop() ?? '';
      return { ok: r.status === 0, message: text };
    },
    lockHolder: () => lockHolder(EVENT_DIR),
    pageWrittenAt: (dir) => { const file = join(dir, PODIUM_FILE); return existsSync(file) ? statSync(file).mtimeMs : null; },
    waitCommand: `node ${shq(loop)} events wait`,
    repairStanding: () => repairStandingWatches(EVENT_DIR, BUILTIN_TYPES, now),
    drainDigests: () => {
      if (!LEDGER_ROOT) return [];
      const dir = digestDir(LEDGER_ROOT, CONTAINER_PROJECT);
      return drainDigests(dir, now);
    },
    loopHealth: () => liveLoopHealth(now).line,
    webProbe: () => { const url = podiumWebUrl(STATUS_PAGE_URI_SETTING); return { url, up: !url || connects(url) }; },
  };
}

function main(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, options: { 'status-dir': { type: 'string' }, project: { type: 'string' } } });
  const statusDir = v['status-dir'] || statusDirFor(v.project || CONTAINER_PROJECT);
  if (!statusDir) { console.error('session-start: no status directory; set status_dir or vault_root (or pass --status-dir)'); return 2; }
  try {
    const report = sessionStart(statusDir, realDeps());
    console.log(report.lines.join('\n'));
    return report.failed ? 1 : 0;
  } catch (err) {
    console.error(`session-start: the watch registry could not be read or written: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
