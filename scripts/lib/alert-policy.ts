/**
 * When the loop texts Jack (decision D4 of the resilient-event-loop plan). `decide` is pure: it takes the inbox, the loop's health and the
 * saved alert state, and returns the one line to send (or none) and the state to save. `runAlerts` is the thin shell that reads and writes those.
 *
 * Policy:
 *   - away: an actionable event counts only when no session has seen it for AWAY_MS (10 min), and it is not handled;
 *   - kind allowlist: changes-requested, conflict, approved-unmerged, reminder, notion-changed, and a human thread or reply. Never a bot thread,
 *     never an info event, never a text from Jack;
 *   - health: loop DOWN or STALLED for HEALTH_AFTER_MS (15 min) in waking hours, a check that keeps failing, and the first healthy start ever seen;
 *   - rate limit: at most one text per RATE_MS (20 min); everything pending goes out as one batched line;
 *   - quiet hours (default 23:00-07:00): nothing is sent; what is still pending goes out as one morning line.
 *
 * The guarantee that no free text reaches the phone is enforced here, not described: a line is built only by `describe`, which reads `kind`
 * (checked against the allowlist), `fields.repo` (checked against a repo pattern) and `fields.number` (a positive integer) from a row that
 * `cleanFields` has already filtered again. A summary is never an input to `decide`: `InboxEntry` has none. alert-policy.test.ts feeds a
 * sentinel through the real inbox write path, and through hand-built hostile rows, and asserts it is absent from the notifier's argv.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { localClock, parseQuietHours } from './cadence.ts';
import { cleanFields } from './event-inbox.ts';
import type { InboxEntry } from './event-inbox.ts';
import type { LoopHealth } from './loop-health.ts';

export const AWAY_MS = 10 * 60_000;
export const RATE_MS = 20 * 60_000;
export const HEALTH_AFTER_MS = 15 * 60_000;
export const DEFAULT_ALERT_QUIET_HOURS = '23:00-07:00';
const MAX_REMEMBERED = 200;
const MAX_LISTED = 3;
/** A notifier that keeps failing is retried after RATE_MS, then 2x, 4x, 8x (capped), not on every tick: it may have delivered before it failed. */
const MAX_BACKOFF_DOUBLINGS = 3;

/** Kinds that may be texted whoever raised them. */
const ALWAYS_KINDS = new Set(['changes-requested', 'conflict', 'approved-unmerged', 'reminder', 'notion-changed']);
/** Kinds that may be texted only when a human raised them; a bot or unknown author never texts. */
const HUMAN_KINDS = new Set(['thread', 'reply']);
/** Inbox kinds that mean the loop itself is failing; reported as a health alert, never with a name. */
const FAILING_KINDS = new Set(['check-failing']);

export interface AlertState {
  /** Epoch ms of the last text sent. */
  lastSentAt: number;
  /** Ids of events already texted (newest last, capped). */
  alerted: string[];
  /** When the loop was first seen DOWN or STALLED in this stretch; 0 when it is fine. */
  badSince: number;
  /** True once a DOWN or STALLED stretch has been texted, until the loop is seen healthy again. */
  badAlerted: boolean;
  /** True once the first-start text went out. */
  startSent: boolean;
  /** Sends in a row that failed (non-zero exit, error or timeout); each doubles the wait before the next try, up to MAX_BACKOFF_DOUBLINGS. 0 after a send that worked. */
  failures: number;
}

export const emptyState = (): AlertState => ({ lastSentAt: 0, alerted: [], badSince: 0, badAlerted: false, startSent: false, failures: 0 });

export interface AlertConfig { quietHours: string; tz: string }

export interface Decision { text: string | null; state: AlertState; ids: string[] }

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** `arya-scraper#542 conflict`: kind and repo and number only, each re-checked here. null when the kind is not texted. */
function describe(e: InboxEntry): string | null {
  const f = cleanFields(e.fields);
  const allowed = ALWAYS_KINDS.has(e.kind) || (HUMAN_KINDS.has(e.kind) && f.who === 'human');
  if (!allowed) return null;
  const where = f.repo && REPO.test(f.repo) && f.number ? `${f.repo.split('/')[1]}#${f.number}` : f.repo && REPO.test(f.repo) ? f.repo.split('/')[1] : '';
  return `${where ? `${where} ` : ''}${e.kind}`;
}

const inQuiet = (now: number, cfg: AlertConfig): boolean => {
  const w = parseQuietHours(cfg.quietHours);
  if (!w) return false;
  const { minutes } = localClock(now, cfg.tz);
  return w.start <= w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end;
};

export interface DecideInput { now: number; entries: InboxEntry[]; health: LoopHealth; state: AlertState; config: AlertConfig }

/** What to send now, if anything, and the state afterwards. Events count as alerted, and the send time moves, only when `text` is non-null; with no text only the health clock (`badSince`, `badAlerted`) can change. */
export function decide({ now, entries, health, state, config }: DecideInput): Decision {
  const next: AlertState = { ...state, alerted: [...state.alerted] };
  const bad = health.state === 'down' || health.state === 'stalled';
  if (bad) { if (!next.badSince) next.badSince = now; } else { next.badSince = 0; next.badAlerted = false; }

  const known = new Set(state.alerted);
  const due = entries.filter((e) => e.actionable && !e.handled && !e.seen && !known.has(e.id) && now - Date.parse(e.at) >= AWAY_MS);
  const items = due.flatMap((e) => { const d = describe(e); return d ? [{ id: e.id, text: d }] : []; });
  const failing = due.filter((e) => FAILING_KINDS.has(e.kind));
  const parts: string[] = [];
  const ids: string[] = items.map((i) => i.id);

  if (items.length === 1) parts.push(items[0]!.text);
  else if (items.length > 1) parts.push(`${items.length} PR events: ${items.slice(0, MAX_LISTED).map((i) => i.text).join(', ')}${items.length > MAX_LISTED ? `, +${items.length - MAX_LISTED}` : ''}`);
  if (failing.length) { parts.push(`${failing.length} loop check${failing.length === 1 ? '' : 's'} failing`); ids.push(...failing.map((e) => e.id)); }
  const badDue = bad && !next.badAlerted && now - next.badSince >= HEALTH_AFTER_MS;
  if (badDue) parts.push(`loop ${health.state === 'down' ? 'DOWN' : 'STALLED'}`);
  const startDue = !next.startSent && !bad && (health.state === 'ok' || health.state === 'quiet' || health.state === 'running');
  if (startDue) parts.push('loop started');

  if (!parts.length || inQuiet(now, config) || now - state.lastSentAt < RATE_MS * 2 ** Math.min(state.failures, MAX_BACKOFF_DOUBLINGS)) return { text: null, state: { ...state, badSince: next.badSince, badAlerted: next.badAlerted }, ids: [] };
  next.lastSentAt = now;
  next.failures = 0;
  next.alerted = [...next.alerted, ...ids].slice(-MAX_REMEMBERED);
  if (badDue) next.badAlerted = true;
  if (startDue) next.startSent = true;
  return { text: `maestro: ${parts.join('; ')}`, state: next, ids };
}

export const alertsPath = (eventDir: string): string => join(eventDir, 'alerts.json');

/** The saved state, or an empty one when the file is missing or not shaped as written below. */
export function readAlertState(eventDir: string): AlertState {
  try {
    const r = JSON.parse(readFileSync(alertsPath(eventDir), 'utf8')) as Partial<AlertState>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return { lastSentAt: num(r.lastSentAt), badSince: num(r.badSince), badAlerted: r.badAlerted === true, startSent: r.startSent === true, failures: Math.min(Math.floor(num(r.failures)), MAX_BACKOFF_DOUBLINGS), alerted: Array.isArray(r.alerted) ? r.alerted.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)).slice(-MAX_REMEMBERED) : [] };
  } catch { return emptyState(); }
}

/** Writes the state atomically. */
export function writeAlertState(eventDir: string, state: AlertState): void {
  mkdirSync(eventDir, { recursive: true });
  const tmp = `${alertsPath(eventDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, alertsPath(eventDir));
}

export type SendRun = (cmd: string, args: string[]) => { status?: number | null; error?: Error } | undefined;

export interface AlertDeps {
  eventDir: string;
  command: string[];
  now: number;
  entries: InboxEntry[];
  health: LoopHealth;
  config: AlertConfig;
  run?: SendRun;
}

/** One alert tick: decide, send through `command` (its argv is `command.slice(1)` plus the one line), and save the state after a send that worked, and after a failed one only to stamp the attempt (so a notifier that fails after delivering is not re-sent on every tick). Returns the line sent, or null. Never throws. */
export function runAlerts({ eventDir, command, now, entries, health, config, run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 30_000 }) }: AlertDeps): string | null {
  try {
    if (!command.length) return null;
    const state = existsSync(alertsPath(eventDir)) ? readAlertState(eventDir) : emptyState();
    const d = decide({ now, entries, health, state, config });
    if (!d.text) { if (d.state.badSince !== state.badSince || d.state.badAlerted !== state.badAlerted) writeAlertState(eventDir, d.state); return null; }
    const r = run(command[0] as string, [...command.slice(1), d.text]);
    if (r?.error || r?.status) {
      // The notifier may have delivered before it failed (non-zero exit, or killed by the timeout), so the attempt counts against the rate limit; events stay unalerted for the retry.
      writeAlertState(eventDir, { ...state, badSince: d.state.badSince, badAlerted: d.state.badAlerted, lastSentAt: now, failures: Math.min(state.failures + 1, MAX_BACKOFF_DOUBLINGS) });
      console.error(`alert send failed: ${r.error?.message ?? `exit ${r.status}`}`);
      return null;
    }
    writeAlertState(eventDir, d.state);
    return d.text;
  } catch (err) {
    console.error(`alert tick failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
