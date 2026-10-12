/**
 * Session launcher policy: when nothing is listening to the loop, start a session so an actionable event is not left waiting for Jack to type.
 * `decideWake` is pure: it takes the inbox, whether a waiter or an interactive transcript is live, and the saved launch history, and returns what to do.
 * `runWakeTick` is the thin shell around it. The supervisor calls it on its alert timer.
 *
 * A launch needs ALL of: an unseen actionable event older than GRACE_MS (a waiter or a hook usually reads it first), no live waiter (lib/waiters.ts),
 * no interactive transcript written in TRANSCRIPT_WINDOW_MS (a session is open and Jack is probably in it), at least MIN_GAP_MS since the last launch,
 * fewer than MAX_PER_DAY launches in 24 hours, and a configured `wake_launch_command`. With no launch command nothing happens: launching is off until
 * the install opts in. There is no text fallback, because the alert policy (lib/alert-policy.ts) already texts an unseen event that nobody has acted on.
 *
 * What reaches the launch command is fixed here, not described: its argv is the configured command plus WAKE_PROMPT, a constant. No event text, no
 * watch name and no path is an input to `decideWake` or to the argv, and the log rows hold only a time, an action and a reason from a closed set.
 * The new session reads the digests under its normal trust rules.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { InboxEntry } from './event-inbox.ts';
import { liveTranscripts } from './continuous-roll.ts';
import { liveWaiters } from './waiters.ts';

export const WAKE_PROMPT = 'the-maestro wake: run session-start, read the unseen digests, then follow the adopted queue.';
export const GRACE_MS = 3 * 60_000;
export const MIN_GAP_MS = 30 * 60_000;
export const MAX_PER_DAY = 4;
export const TRANSCRIPT_WINDOW_MS = 15 * 60_000;
const DAY_MS = 24 * 3_600_000;

export type WakeAction = 'launch' | 'none';
export type WakeReason = 'nothing-waiting' | 'within-grace' | 'waiter-live' | 'session-active' | 'rate-limited' | 'no-command' | 'launched';

export interface WakeState {
  /** Epoch ms of recent launch attempts (a failed one counts: the command may have opened a window before it failed), pruned to a day. */
  launches: number[];
}

export const emptyWakeState = (): WakeState => ({ launches: [] });

export interface WakeInput {
  now: number;
  entries: InboxEntry[];
  waiterLive: boolean;
  sessionActive: boolean;
  state: WakeState;
  hasLaunchCommand: boolean;
}

export interface WakeDecision { action: WakeAction; reason: WakeReason }

/** What to do now. Pure. The order of the guards is the order of the reasons: a quiet inbox is never "rate-limited". */
export function decideWake({ now, entries, waiterLive, sessionActive, state, hasLaunchCommand }: WakeInput): WakeDecision {
  const pending = entries.filter((e) => e.actionable && !e.seen && !e.handled);
  if (!pending.length) return { action: 'none', reason: 'nothing-waiting' };
  if (!pending.some((e) => now - Date.parse(e.at) >= GRACE_MS)) return { action: 'none', reason: 'within-grace' };
  if (waiterLive) return { action: 'none', reason: 'waiter-live' };
  if (sessionActive) return { action: 'none', reason: 'session-active' };
  if (!hasLaunchCommand) return { action: 'none', reason: 'no-command' };
  const recent = state.launches.filter((t) => now - t < DAY_MS);
  const limited = recent.length >= MAX_PER_DAY || recent.some((t) => now - t < MIN_GAP_MS);
  return limited ? { action: 'none', reason: 'rate-limited' } : { action: 'launch', reason: 'launched' };
}

export const wakeStatePath = (eventDir: string): string => join(eventDir, 'wake-launch.json');
export const wakeLogPath = (eventDir: string): string => join(eventDir, 'wake-launch.jsonl');

/** The saved history; an absent or unreadable file is empty, so a damaged one can only allow a launch the other guards still gate. */
export function readWakeState(eventDir: string): WakeState {
  try {
    const v = JSON.parse(readFileSync(wakeStatePath(eventDir), 'utf8')) as Partial<WakeState>;
    const times = Array.isArray(v.launches) ? v.launches.filter((t): t is number => Number.isFinite(t)) : [];
    return { launches: times };
  } catch { return emptyWakeState(); }
}

function writeWakeState(eventDir: string, state: WakeState): void {
  mkdirSync(eventDir, { recursive: true });
  const tmp = `${wakeStatePath(eventDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, wakeStatePath(eventDir));
}

export type WakeRun = (cmd: string, args: string[]) => { status?: number | null; error?: Error } | undefined;

export interface WakeTickDeps {
  eventDir: string;
  now: number;
  entries: InboxEntry[];
  launchCommand: string[];
  /** Claude Code's transcript folder for the orchestrator; unset or missing counts as no active session. */
  transcriptsDir: string;
  run?: WakeRun;
  alive?: (pid: number) => boolean;
}

/**
 * One tick: decide, record, act. Returns the decision. Never throws: a broken launcher or an unreadable inbox must not stop the supervisor.
 * The launch is counted in wake-launch.json before the command runs, and only if that save worked, so a full disk cannot turn into a launch every tick. It is logged to wake-launch.jsonl whether or not the command worked.
 */
export function runWakeTick({ eventDir, now, entries, launchCommand, transcriptsDir, run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 30_000 }), alive }: WakeTickDeps): WakeDecision {
  try {
    const state = readWakeState(eventDir);
    const d = decideWake({
      now, entries, state,
      waiterLive: liveWaiters(eventDir, alive).length > 0,
      sessionActive: transcriptsDir !== '' && liveTranscripts(transcriptsDir, now, TRANSCRIPT_WINDOW_MS).length > 0,
      hasLaunchCommand: launchCommand.length > 0,
    });
    if (d.action === 'none') return d;
    const [cmd, ...args] = launchCommand;
    // Reserve the slot first: if the history cannot be saved the throw lands in the catch below and nothing launches, so the cap can never be open-ended.
    writeWakeState(eventDir, { launches: [...state.launches.filter((t) => now - t < DAY_MS), now] });
    const r = run(cmd as string, [...args, WAKE_PROMPT]);
    const ok = !(r?.error || r?.status);
    appendFileSync(wakeLogPath(eventDir), `${JSON.stringify({ at: new Date(now).toISOString(), action: d.action, reason: d.reason, ok })}\n`);
    if (!ok) console.error(`wake launch failed: ${r?.error?.message ?? `exit ${r?.status}`}`);
    return d;
  } catch (err) {
    console.error(`wake tick failed: ${err instanceof Error ? err.message : String(err)}`);
    return { action: 'none', reason: 'nothing-waiting' };
  }
}
