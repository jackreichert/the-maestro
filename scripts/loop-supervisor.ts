#!/usr/bin/env node
/**
 * loop-supervisor.ts: keeps `event-loop.ts run` alive without a session. launchd runs this (KeepAlive); it loops:
 *
 *   exit 10  save the digest (stdout) under <ledger root>/Projects/<project>/Journal/Digests/, relaunch at once
 *   exit 3   sleep until the `QUIET-HOURS stop until HH:MM <tz>` time (capped at 12h), relaunch
 *   exit 0   sleep 300s (watches may be added later), relaunch
 *   exit 2   log the stderr line, sleep 300s, relaunch; the lock is never touched (another loop may own it)
 *   other    log, sleep 30s, relaunch
 *
 * Digests are written only under the ledger root; with no ledger root the supervisor refuses to start (exit 2).
 * While it runs it keeps <event dir>/supervisor.json ({ pid, startedAt }); a stop by SIGTERM or SIGINT removes it, so `prime` can tell a
 * supervisor that was stopped from one that died (lib/supervisor-state.ts).
 * Test hooks: MAESTRO_LOOP_BIN replaces `node event-loop.ts` (called as `<bin> run`), MAESTRO_SUPERVISOR_MAX_RUNS stops after N launches.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localClock } from './lib/cadence.ts';
import { digestDir, saveDigest } from './lib/digest-store.ts';
import { clearRecord, writeRecord } from './lib/supervisor-state.ts';
import { CONTAINER_PROJECT, EVENT_DIR, LEDGER_ROOT } from './local-config.ts';

const EVENT_LOOP = fileURLToPath(new URL('./event-loop.ts', import.meta.url));
export const DELAYS = { idle: 300, usage: 300, crash: 30, quietCap: 12 * 3600, quietFallback: 300 };

/** What one launch of the loop produced. */
export interface LoopResult { code: number | null; stdout: string; stderr: string }

/** Everything `supervise` touches outside itself, so tests can fake it. */
export interface SuperviseDeps {
  runLoop: () => Promise<LoopResult>;
  sleep: (seconds: number) => Promise<void>;
  save: (digest: string) => void;
  log: (line: string) => void;
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
export async function supervise({ runLoop, sleep, save, log, now = Date.now, maxRuns = Infinity }: SuperviseDeps): Promise<void> {
  for (let runs = 0; runs < maxRuns; runs += 1) {
    const { code, stdout, stderr } = await runLoop();
    if (code === 10) {
      try { save(stdout); } catch (err) { log(`could not save digest: ${err instanceof Error ? err.message : String(err)}`); log(`unsaved digest follows:\n${stdout.trimEnd()}`); await sleep(DELAYS.crash); }
    } else if (code === 3) {
      const seconds = quietSleepSeconds(stdout, now());
      if (seconds === null) log(`quiet-hours stop with no readable time: ${lastLine(stdout)}`);
      await sleep(seconds ?? DELAYS.quietFallback);
    } else if (code === 0) {
      await sleep(DELAYS.idle);
    } else if (code === 2) {
      log(`event-loop refused to run: ${lastLine(stderr)}`);
      await sleep(DELAYS.usage);
    } else {
      log(`event-loop exited ${code}: ${lastLine(stderr)}`);
      await sleep(DELAYS.crash);
    }
  }
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

const stamped = (line: string): string => `${new Date().toISOString()} loop-supervisor: ${line}`;

async function main(): Promise<number> {
  if (!LEDGER_ROOT) { console.error(stamped('no ledger root; set LEDGER_ROOT (digests are saved only under it)')); return 2; }
  const dir = digestDir(LEDGER_ROOT, CONTAINER_PROJECT);
  const max = Number(process.env.MAESTRO_SUPERVISOR_MAX_RUNS);
  console.error(stamped(`supervising; digests go to ${dir}`));
  writeRecord(EVENT_DIR, process.pid);
  stopOnSignals(EVENT_DIR);
  await supervise({
    runLoop: launch,
    sleep: (s) => new Promise((r) => setTimeout(r, s * 1000)),
    save: (digest) => { console.error(stamped(`digest saved: ${saveDigest(dir, digest)}`)); },
    log: (line) => console.error(stamped(line)),
    maxRuns: max > 0 ? max : Infinity,
  });
  return 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) main().then((code) => { process.exitCode = code; });
