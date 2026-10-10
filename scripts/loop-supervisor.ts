#!/usr/bin/env node
/**
 * loop-supervisor.ts: keeps `event-loop.ts run` alive without a session. launchd runs this (KeepAlive); it loops:
 *
 *   exit 10  save the digest (stdout) under <ledger root>/Projects/<project>/Journal/Digests/, then queue
 *            always-actionable pr-watch lines (rules only; a queue failure is logged and does not stop the loop), relaunch at once
 *   exit 3   sleep until the `QUIET-HOURS stop until HH:MM <tz>` time (capped at 12h), relaunch
 *   exit 0   sleep 300s (watches may be added later), relaunch
 *   exit 2   log the stderr line, sleep 300s, relaunch; the lock is never touched (another loop may own it)
 *   other    log, sleep 30s, relaunch
 *
 * Digests are written only under the ledger root; with no ledger root the supervisor refuses to start (exit 2).
 * While it runs it keeps <event dir>/supervisor.json ({ pid, startedAt }); a stop by SIGTERM or SIGINT removes it, so `prime` can tell a
 * supervisor that was stopped from one that died (lib/supervisor-state.ts).
 * While it waits (idle, quiet hours or crash back-off) it sleeps in chunks of at most 60 s against the wall clock, so a closed lid costs
 * under a minute, and rewrites <event dir>/heartbeat.json each chunk with mode `idle`, `quiet` or `backoff`, so a supervisor between loop launches
 * still reads as alive (lib/loop-health.ts). The loop writes its own heartbeat while it runs.
 * Test hooks: MAESTRO_LOOP_BIN replaces `node event-loop.ts` (called as `<bin> run`), MAESTRO_SUPERVISOR_MAX_RUNS stops after N launches.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localClock } from './lib/cadence.ts';
import { digestDir, saveDigest } from './lib/digest-store.ts';
import { digestQueueOwners, queueActionableDigest, queuedFixKeys } from './lib/digest-queue.ts';
import type { DigestFix } from './lib/digest-queue.ts';
import { writeHeartbeat } from './lib/heartbeat.ts';
import type { HeartbeatMode } from './lib/heartbeat.ts';
import { openStore } from './lib/journal/store.ts';
import { sleepUntil } from './lib/wall-sleep.ts';
import { clearRecord, writeRecord } from './lib/supervisor-state.ts';
import { CONTAINER_PROJECT, COPILOT_ORGS, EVENT_DIR, GH_ORG, LEDGER_ROOT, NOTIFY_COMMAND, SELF_REVIEW_REPOS, WATCH_TZ } from './local-config.ts';
import { DEFAULT_ALERT_QUIET_HOURS, runAlerts } from './lib/alert-policy.ts';
import { readInbox } from './lib/event-inbox.ts';
import { liveLoopHealth } from './lib/loop-health-live.ts';

const EVENT_LOOP = fileURLToPath(new URL('./event-loop.ts', import.meta.url));
export const DELAYS = { idle: 300, usage: 300, crash: 30, quietCap: 12 * 3600, quietFallback: 300 };

/** What one launch of the loop produced. */
export interface LoopResult { code: number | null; stdout: string; stderr: string }

/** Everything `supervise` touches outside itself, so tests can fake it. */
export interface SuperviseDeps {
  runLoop: () => Promise<LoopResult>;
  /** `mode` says why: `quiet` for a quiet-hours stop, `backoff` (with `lastError`) after a refusal, a crash or an unsaved digest, `idle` for every other wait (the heartbeat records it). */
  sleep: (seconds: number, mode?: HeartbeatMode, lastError?: string) => Promise<void>;
  save: (digest: string) => void;
  log: (line: string) => void;
  /** Called with the digest text after a successful save. A throw is logged; it does not stop the loop. */
  queueDigest?: (digest: string) => void;
  now?: () => number;
  maxRuns?: number;
}

/**
 * Seconds from `now` until the wall clock of `tz` next reads HH:MM, found by scanning forward minute by minute (so a DST change
 * in between is honoured), at most the 12h cap; null when the text is not a time or zone. Already at HH:MM counts as a full wait.
 */
export function secondsUntilClock(now: number, hhmm: string, tz: string): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const target = Number(m[1]) * 60 + Number(m[2]);
  const nextMinute = (Math.floor(now / 60000) + 1) * 60000;
  try {
    for (let at = nextMinute; at - now <= DELAYS.quietCap * 1000; at += 60000) {
      if (localClock(at, tz).minutes === target) return Math.max(1, Math.ceil((at - now) / 1000));
    }
  } catch { return null; }
  return DELAYS.quietCap;
}

/** Seconds to sleep for a quiet-hours stop, read from the loop's stdout; null when no `QUIET-HOURS stop until HH:MM <tz>` line is there. */
export function quietSleepSeconds(stdout: string, now: number): number | null {
  const m = stdout.match(/QUIET-HOURS stop until (\d{1,2}:\d{2}) (\S+)/);
  return m ? secondsUntilClock(now, m[1], m[2]) : null;
}

const lastLine = (text: string): string => text.trim().split('\n').pop() ?? '';

/** The supervision loop. Returns only when `maxRuns` launches are done (never, in production). */
export async function supervise({ runLoop, sleep, save, log, queueDigest, now = Date.now, maxRuns = Infinity }: SuperviseDeps): Promise<void> {
  for (let runs = 0; runs < maxRuns; runs += 1) {
    const { code, stdout, stderr } = await runLoop();
    if (code === 10) {
      let saved = false;
      try { save(stdout); saved = true; } catch (err) { log(`could not save digest: ${err instanceof Error ? err.message : String(err)}`); log(`unsaved digest follows:\n${stdout.trimEnd()}`); await sleep(DELAYS.crash, 'backoff', 'could not save digest'); }
      if (saved && queueDigest) {
        try { queueDigest(stdout); } catch (err) { log(`could not queue digest fixes: ${err instanceof Error ? err.message : String(err)}`); }
      }
    } else if (code === 3) {
      const seconds = quietSleepSeconds(stdout, now());
      if (seconds === null) log(`quiet-hours stop with no readable time: ${lastLine(stdout)}`);
      await sleep(seconds ?? DELAYS.quietFallback, 'quiet');
    } else if (code === 0) {
      await sleep(DELAYS.idle);
    } else if (code === 2) {
      log(`event-loop refused to run: ${lastLine(stderr)}`);
      await sleep(DELAYS.usage, 'backoff', lastLine(stderr));
    } else {
      log(`event-loop exited ${code}: ${lastLine(stderr)}`);
      await sleep(DELAYS.crash, 'backoff', `exited ${code}: ${lastLine(stderr)}`);
    }
  }
}

export interface WaitDeps {
  beat: (mode: HeartbeatMode, until: number, lastError: string) => void;
  /** The text-alert policy (lib/alert-policy.ts). A throw is logged; it does not stop the wait. */
  alertTick: () => void;
  log: (line: string) => void;
  now?: () => number;
  /** Real sleep for the given seconds; replaced in tests. */
  nap: (seconds: number) => Promise<void>;
}

/**
 * The supervisor's `sleep`: every chunk writes the supervisor's own heartbeat, then runs the alert tick. The tick must come after the beat:
 * right after the loop child exits, the newest heartbeat is the dead child's `run` beat and the lock is free, so health reads `down`
 * even though the supervisor is about to relaunch it. A launch that is relaunched at once (exit 10) has no wait, so it has no tick.
 */
export function waitWithAlerts({ beat, alertTick, log, now = Date.now, nap }: WaitDeps): SuperviseDeps['sleep'] {
  return (seconds, mode = 'idle', lastError = '') => sleepUntil(now() + seconds * 1000, {
    now,
    sleep: nap,
    onChunk: (until) => {
      beat(mode, until, lastError);
      try { alertTick(); } catch (err) { log(`alert tick failed: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
}

/** The loop launched most recently while it runs, so a stop signal can reach it. */
let running: ChildProcess | null = null;

/** Launches the real loop (or MAESTRO_LOOP_BIN) once, collecting its output. */
function launch(): Promise<LoopResult> {
  const bin = process.env.MAESTRO_LOOP_BIN;
  const child = bin ? spawn(bin, ['run'], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(process.execPath, [EVENT_LOOP, 'run'], { stdio: ['ignore', 'pipe', 'pipe'] });
  running = child;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  return new Promise((resolve) => {
    child.on('error', (err) => { running = null; resolve({ code: -1, stdout, stderr: err.message }); });
    child.on('close', (code) => { running = null; resolve({ code, stdout, stderr }); });
  });
}

/** Stops on SIGTERM or SIGINT: forwards the signal to a running loop so it releases its lock, then drops the liveness record and exits 0. */
function stopOnSignals(eventDir: string): void {
  const stop = (sig: NodeJS.Signals): void => {
    const done = (): void => { clearRecord(eventDir, process.pid); process.exit(0); };
    if (running) { running.once('exit', done); running.kill(sig); } else done();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

const JOURNAL = fileURLToPath(new URL('./journal.ts', import.meta.url));

/** Open fix keys already in the ledger. A missing file is an empty set; a read error is the caller's to catch. */
function readQueuedKeys(vault: string, project: string): Set<string> {
  const store = openStore({ vault, project, dryRun: true, warn: () => {} });
  return queuedFixKeys(existsSync(store.ledgerPath) ? readFileSync(store.ledgerPath, 'utf8') : '');
}

/** Appends one fix through `journal.ts queue`. Throws on a non-zero exit; the caller logs and continues. */
function enqueueFix(item: DigestFix, vault: string, project: string): void {
  const r = spawnSync(process.execPath, [
    JOURNAL, 'queue', item.text,
    '--repo', item.repo,
    '--model', 'unrecorded',
    '--used', 'tool:loop-supervisor',
    '--vault', vault,
    '--project', project,
  ], {
    encoding: 'utf8',
    env: { ...process.env, LEDGER_ROOT: vault, MAESTRO_PROJECT: project },
  });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').pop()?.slice(0, 200) ?? '';
    throw new Error(detail ? `journal.ts queue exited ${r.status}: ${detail}` : `journal.ts queue exited ${r.status}`);
  }
}

/**
 * Production callback for an exit-10 digest that was just saved. Owners come from `copilot_orgs`, else `gh_org`.
 * Neither set: log and queue nothing. A per-item failure is logged; it does not throw.
 */
export function queueSavedDigest(digest: string, log: (line: string) => void, opts: {
  vault: string;
  project: string;
  owners?: readonly string[];
  excludeRepos?: readonly string[];
  enqueue?: (item: DigestFix) => void;
}): void {
  const owners = opts.owners ?? digestQueueOwners(COPILOT_ORGS, GH_ORG);
  const excludeRepos = opts.excludeRepos ?? SELF_REVIEW_REPOS;
  let already: Set<string>;
  try {
    already = readQueuedKeys(opts.vault, opts.project);
  } catch (err) {
    log(`could not read queued fixes: ${err instanceof Error ? err.message : String(err)}; not queueing`);
    return;
  }
  const enqueue = opts.enqueue ?? ((item: DigestFix) => enqueueFix(item, opts.vault, opts.project));
  queueActionableDigest(digest, {
    owners,
    excludeRepos,
    alreadyQueued: already,
    log,
    queue: (item) => {
      try { enqueue(item); } catch (err) { log(`could not queue ${item.key}: ${err instanceof Error ? err.message : String(err)}`); }
    },
  });
}

const stamped = (line: string): string => `${new Date().toISOString()} loop-supervisor: ${line}`;

/** The supervisor's own heartbeat while it waits. Never throws: it is advisory. */
function beat(mode: HeartbeatMode, until: number, lastError: string): void {
  try { writeHeartbeat(EVENT_DIR, { pid: process.pid, at: new Date().toISOString(), tick: 0, watchesLive: 0, sleepingUntil: new Date(until).toISOString(), mode, lastError: lastError.slice(0, 200) }); } catch { /* advisory */ }
}

async function main(): Promise<number> {
  if (!LEDGER_ROOT) { console.error(stamped('no ledger root; set LEDGER_ROOT (digests are saved only under it)')); return 2; }
  const dir = digestDir(LEDGER_ROOT, CONTAINER_PROJECT);
  const max = Number(process.env.MAESTRO_SUPERVISOR_MAX_RUNS);
  console.error(stamped(`supervising; digests go to ${dir}`));
  writeRecord(EVENT_DIR, process.pid);
  stopOnSignals(EVENT_DIR);
  await supervise({
    runLoop: launch,
    sleep: waitWithAlerts({
      beat,
      alertTick: () => { runAlerts({ eventDir: EVENT_DIR, command: NOTIFY_COMMAND, now: Date.now(), entries: readInbox(EVENT_DIR), health: liveLoopHealth(), config: { quietHours: DEFAULT_ALERT_QUIET_HOURS, tz: WATCH_TZ } }); },
      log: (line) => console.error(stamped(line)),
      nap: (chunk) => new Promise((r) => setTimeout(r, chunk * 1000)),
    }),
    save: (digest) => { console.error(stamped(`digest saved: ${saveDigest(dir, digest)}`)); },
    log: (line) => console.error(stamped(line)),
    queueDigest: (digest) => queueSavedDigest(digest, (line) => console.error(stamped(line)), {
      vault: LEDGER_ROOT,
      project: CONTAINER_PROJECT,
    }),
    maxRuns: max > 0 ? max : Infinity,
  });
  return 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) main().then((code) => { process.exitCode = code; });
