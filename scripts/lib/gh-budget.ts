/**
 * The GitHub GraphQL budget: what each `gh` call is, a log of the calls, and the guard that stops calling GitHub while the account is limited.
 *
 * Why the GraphQL `rateLimit` field and not `gh api rate_limit`: on 2026-10-15 the REST endpoint kept saying about 4,700 GraphQL
 * calls were left while every GraphQL call failed with "API rate limit already exceeded for user". Its graphql bucket does not track
 * what GraphQL itself charges, so the budget is read from the `rateLimit` field of a GraphQL response (about one point a read).
 *
 * State lives in the event dir: `gh-budget.json` (the last probe and any block) and `gh-calls.jsonl` (one line per call). Everything here
 * takes the directory and the clock as arguments; scripts/gh-guard.ts is what runs it around each real `gh`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rotateLog } from './log-rotate.ts';

/** `graphql` spends the GraphQL budget; `rest` spends the core one; `free` spends nothing (local config, the rate-limit read). */
export type GhKind = 'graphql' | 'rest' | 'free';

export const STATE_FILE = 'gh-budget.json';
export const CALLS_FILE = 'gh-calls.jsonl';
/** Below this many points left the guard blocks GraphQL calls until the window resets. */
export const FLOOR = 300;
/** How long a probe of the budget is trusted. */
export const PROBE_MS = 2 * 60_000;
/** The longest a failure-driven block lasts when GitHub gave no reset time. */
export const MAX_BACKOFF_MS = 30 * 60_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface BudgetState {
  /** Points left at the last probe, the window's size, and when it resets (ms). */
  remaining?: number;
  limit?: number;
  resetAt?: number;
  probedAt?: number;
  /** GraphQL calls fail fast until this time (ms). */
  blockedUntil?: number;
  /** Consecutive rate-limit failures, for the backoff. */
  failures?: number;
  reason?: string;
}

export interface CallRecord { t: number; kind: GhKind; caller: string; cmd: string; status: number | null }

const FREE_COMMANDS = new Set(['auth', 'config', 'alias', 'extension', 'completion', 'version', 'help', 'status']);
const GRAPHQL_COMMANDS = new Set(['pr', 'issue', 'project', 'repo', 'release', 'label']);

/** What a `gh` call spends. `gh pr ...`, `gh issue ...` and `gh api graphql` are GraphQL; `gh api <path>`, `gh run` and `gh search` are REST. */
export function classifyGh(args: string[]): GhKind {
  const [cmd, ...rest] = args.filter((a) => !a.startsWith('-'));
  if (!cmd || FREE_COMMANDS.has(cmd)) return 'free';
  if (cmd === 'api') return rest[0] === 'rate_limit' ? 'free' : rest[0] === 'graphql' ? 'graphql' : 'rest';
  return GRAPHQL_COMMANDS.has(cmd) ? 'graphql' : 'rest';
}

/** True when gh's stderr says GitHub refused the call for rate reasons (primary, secondary or abuse limits). */
export const isRateLimitError = (stderr: string): boolean => /rate limit|secondary rate|abuse detection|submitted too quickly/i.test(stderr);

export function readState(dir: string): BudgetState {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as BudgetState) : {};
  } catch { return {}; }
}

export function writeState(dir: string, state: BudgetState): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, STATE_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

/** When GraphQL calls are blocked until (ms), or null when they are not blocked at `now`. */
export const blockedUntil = (state: BudgetState, now: number): number | null => (state.blockedUntil !== undefined && state.blockedUntil > now ? state.blockedUntil : null);

/** True when the budget has not been read recently enough to trust. */
export const needsProbe = (state: BudgetState, now: number): boolean => state.probedAt === undefined || now - state.probedAt >= PROBE_MS;

/**
 * The state after a good read of the GraphQL `rateLimit` field: blocked until its reset when under the floor. A healthy read does not
 * lift a block that came from a refused call (the limit may be one `rateLimit` does not show, such as a secondary limit): `clearFailures`
 * does, after a GraphQL call succeeds.
 */
export function applyProbe(state: BudgetState, read: { remaining: number; limit: number; resetAt: number }, now: number, floor: number = FLOOR): BudgetState {
  const low = read.remaining < floor;
  const refused = (state.failures ?? 0) > 0;
  return {
    ...state, ...read, probedAt: now,
    blockedUntil: low ? read.resetAt : refused ? state.blockedUntil : undefined,
    reason: low ? `${read.remaining} of ${read.limit} GraphQL points left` : refused ? state.reason : undefined,
  };
}

/** The state after a GraphQL call succeeded: the backoff from refused calls starts over. */
export function clearFailures(state: BudgetState): BudgetState {
  if (!state.failures && state.blockedUntil === undefined) return state;
  const { failures: _f, blockedUntil: _b, reason: _r, ...rest } = state;
  return rest;
}

/** The state after GitHub refused a call for rate reasons: blocked until the known reset, else a doubling backoff (2, 4, 8 ... minutes, capped). */
export function applyFailure(state: BudgetState, now: number): BudgetState {
  const failures = (state.failures ?? 0) + 1;
  const backoff = Math.min(MAX_BACKOFF_MS, 2 * 60_000 * 2 ** (failures - 1));
  const known = state.resetAt !== undefined && state.resetAt > now && (state.remaining ?? Infinity) < FLOOR ? state.resetAt : 0;
  return { ...state, failures, probedAt: now, blockedUntil: Math.max(known, now + backoff), reason: 'GitHub reported a rate limit' };
}

/** Appends one call to the log; rotates the log when it grows past 2 MB. Never throws: logging must not fail a gh call. */
export function appendCall(dir: string, rec: CallRecord): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, CALLS_FILE);
    rotateLog(path, LOG_MAX_BYTES);
    appendFileSync(path, `${JSON.stringify(rec)}\n`);
  } catch { /* a log that cannot be written is not worth a failed call */ }
}

/** The log's records at or after `since` (ms); unreadable lines are skipped. */
export function readCalls(dir: string, since: number): CallRecord[] {
  const path = join(dir, CALLS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try { const r = JSON.parse(line) as CallRecord; return r.t >= since ? [r] : []; } catch { return []; }
  });
}

/** Calls per hour by caller and kind over the last `hours`, busiest first: `[caller, kind, callsPerHour]`. */
export function callsPerHour(records: CallRecord[], hours: number): [string, GhKind, number][] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(`${r.caller}\t${r.kind}`, (counts.get(`${r.caller}\t${r.kind}`) ?? 0) + 1);
  return [...counts].map(([k, n]): [string, GhKind, number] => { const [caller = '', kind = 'rest'] = k.split('\t'); return [caller, kind as GhKind, Math.round((n / hours) * 10) / 10]; })
    .sort((a, b) => b[2] - a[2]);
}

/** `limited until 9:42 pm ET (reason)` for the footer, or '' when GraphQL calls are not blocked at `now`. */
export function limitedText(state: BudgetState, now: number, tz?: string): string {
  const until = blockedUntil(state, now);
  if (until === null) return '';
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(until)).replace(/ (AM|PM)/, (m) => m.toLowerCase());
  return `limited until ${time}${state.reason ? ` (${state.reason})` : ''}`;
}

/** The footer's GitHub line, `**GitHub:** limited until 9:42 pm EDT (...)`; '' unless GraphQL calls are blocked at `now`. Never throws: a broken read must not take the footer down. */
export function githubFooter(dir: string, now: number, tz?: string): string {
  try {
    const text = limitedText(readState(dir), now, tz);
    return text ? `**GitHub:** ${text}` : '';
  } catch { return ''; }
}
