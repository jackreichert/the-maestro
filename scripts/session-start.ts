#!/usr/bin/env node
/**
 * session-start.ts: the first command of a session. Idempotent; it registers what is missing and reports the rest.
 *
 *   session-start.ts [--status-dir <dir>] [--project <name>]
 *
 * 1. Registers the `status-watch` and `status-refresh` watches (target = the status directory) when no live watch of that type exists.
 *    It goes through `event-loop.ts add`, so each type's own validation, singleton rule and default TTL apply. A watch past its
 *    `expires` that the loop has not retired yet is removed first and registered again.
 * 2. Reports the status page's age (the mtime of The-Podium.md). A page older than 15 minutes means nothing is refreshing it.
 * 3. Reports whether an event loop holds the lock. It never starts the loop itself: a loop must be launched by the orchestrator with
 *    run_in_background (its exit wakes the orchestrator), and a detached child would exit unseen. With no loop it prints the exact command.
 *
 * Exit 0 when nothing failed, 1 when a watch could not be registered, 2 on a usage or configuration error (no status directory).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONTAINER_PROJECT, EVENT_DIR, statusDirFor, WATCH_TZ } from './local-config.ts';
import { PODIUM_FILE } from './lib/status-page/seen.ts';
import { listWatches, lockHolder, removeWatch } from './lib/watch-registry.ts';
import type { Watch } from './lib/types.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
/** The watches a session needs, keyed by the id used when one is missing. */
export const NEEDED = [{ id: 'status-watch', type: 'status-watch' }, { id: 'status-refresh', type: 'status-refresh' }] as const;
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
  lockHolder: () => number | null;
  /** When the page was last written, or null when there is none. */
  pageWrittenAt: (statusDir: string) => number | null;
  /** The command that starts the loop, ready to paste. */
  loopCommand: string;
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

/** Registers the missing watches, then reports page age and loop state. Safe to run any number of times. */
export function sessionStart(statusDir: string, deps: StartDeps): StartReport {
  const lines: string[] = [];
  let failed = false;
  for (const need of NEEDED) {
    const live = deps.watches().filter((w) => w.type === need.type);
    const current = live.find((w) => Date.parse(w.expires) > deps.now);
    if (current) { lines.push(`${need.id}: already registered (${current.id}, expires ${current.expires})`); continue; }
    live.forEach((w) => deps.removeWatch(w.id));
    const added = deps.addWatch(need.id, need.type, statusDir);
    failed ||= !added.ok;
    lines.push(added.ok ? `${need.id}: registered (${added.message})` : `${need.id}: NOT registered (${added.message})`);
  }
  const written = deps.pageWrittenAt(statusDir);
  if (written === null) lines.push(`Status page: none yet (no ${PODIUM_FILE} in ${statusDir}); run \`journal.ts podium\` once`);
  else {
    const age = deps.now - written;
    lines.push(`Status page: updated ${ageText(age)} ago (${clock(written, deps.tz)})${age > STALE_MS ? '; STALE, nothing is refreshing it until the loop runs' : ''}`);
  }
  const holder = deps.lockHolder();
  lines.push(holder === null
    ? `Event loop: NOT RUNNING. Start it now with run_in_background: ${deps.loopCommand}`
    : `Event loop: running (pid ${holder}); leave it alone`);
  return { lines, failed };
}

const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The real world: `event-loop.ts add` for registration, the mtime of the page file, the lock file. */
export function realDeps(now: number = Date.now()): StartDeps {
  const loop = join(SCRIPTS, 'event-loop.ts');
  return {
    now,
    tz: WATCH_TZ,
    watches: () => listWatches(EVENT_DIR),
    removeWatch: (id) => { removeWatch(EVENT_DIR, id, 'expired, replaced at session start', now); },
    addWatch: (id, type, statusDir) => {
      const r = spawnSync(process.execPath, [loop, 'add', '--id', id, '--type', type, '--target', statusDir], { encoding: 'utf8' });
      const text = (r.status === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n').pop() ?? '';
      return { ok: r.status === 0, message: text };
    },
    lockHolder: () => lockHolder(EVENT_DIR),
    pageWrittenAt: (dir) => { const file = join(dir, PODIUM_FILE); return existsSync(file) ? statSync(file).mtimeMs : null; },
    loopCommand: `node ${shq(loop)} run`,
  };
}

function main(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, options: { 'status-dir': { type: 'string' }, project: { type: 'string' } } });
  const statusDir = v['status-dir'] || statusDirFor(v.project || CONTAINER_PROJECT);
  if (!statusDir) { console.error('session-start: no status directory; set status_dir or vault_root (or pass --status-dir)'); return 2; }
  const report = sessionStart(statusDir, realDeps());
  console.log(report.lines.join('\n'));
  return report.failed ? 1 : 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
