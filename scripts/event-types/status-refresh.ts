/**
 * status-refresh: regenerates the Podium (The-Podium.md) inside the event loop, with no model involved. Target is the status
 * directory (the one holding The-Podium.md). A check never throws and its events are never actionable, so a refresh cannot make the loop exit 10.
 * (The loop's own notice that a watch outlived its TTL is the one exception; see the playbook.)
 *
 * A check regenerates when something has made the page dirty and the burst has settled, or when the page is old:
 *   - the ledger changed (a signature of ledger.jsonl, streams.json and priorities.md): wait until it has been quiet for 15 s,
 *     and never more than 60 s after the first change, so a burst of writes gives one regeneration;
 *   - `.now-dirty-prs` was touched (pr-watch and pr-merged do, on any event): same debounce, and the GitHub read is refreshed;
 *   - the idle tick: 10 minutes since the last regeneration.
 * The GitHub read runs only when the PR data is dirty or more than 5 minutes old; otherwise the cached PR set is rendered
 * (.now-prs.json). In quiet hours it never runs: the page is rebuilt from the ledger and the cached PRs, and the PR data
 * stays dirty until the next waking-hours refresh.
 * Edit-quiet window: while The-Podium.md holds an edit the status watcher has not adopted and was saved under 60 s ago, nothing is
 * written; the refresh stays pending and runs once the window has passed. A regeneration that fails (ledger unreadable,
 * another rebuild holding .now.lock) is retried after 2 minutes and reported as a non-actionable event, once per new message.
 * State { sig, firstChange, lastChange, lastRun, markerSeen, prDirty, retryAt, error } is the whole memory; times are epoch ms.
 * Scheduling follows status-watch: a local 30 s check, no idle back-off, singleton, never notifies.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nextInterval } from '../lib/cadence.ts';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT, WATCH_QUIET_HOURS, WATCH_QUIET_WEEKENDS, WATCH_TZ } from '../local-config.ts';
import { prsDirtyAt } from '../lib/status-page/dirty.ts';
import { readPrCache } from '../lib/status-page/prcache.ts';
import { LEGACY_FILE, PODIUM_FILE, readPodium, readSeenMeta, sha } from '../lib/status-page/seen.ts';
import { regenerate } from '../status-page.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface StatusRefreshState {
  sig: string; firstChange: number; lastChange: number; lastRun: number; markerSeen: number; prDirty: boolean; retryAt: number; error: string;
}

export const interval = 30;
export const network = false;
export const backoff = false;
export const singleton = true;
export const slowInQuiet = true;
export const notifies = 'never' as const;

export const SETTLE_MS = 15_000;
export const MAX_DELAY_MS = 60_000;
export const IDLE_MS = 10 * 60_000;
export const PR_MAX_AGE_MS = 5 * 60_000;
export const EDIT_QUIET_MS = 60_000;
export const RETRY_MS = 2 * 60_000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`status-refresh target must be the status directory (the folder holding ${PODIUM_FILE}), got "${target}"`);
}

/** Everything the check reads from or does to the outside world; tests replace it. */
export interface RefreshIo {
  /** Changes whenever the ledger, its stream registry or the priorities file changes. */
  ledgerSig(statusDir: string): string;
  prsDirtyAt(statusDir: string): number;
  /** When the user's unadopted edit of the page was saved, or null when the page holds none. */
  userEditAt(statusDir: string): number | null;
  /** When the page was last written, 0 when there is none. */
  pageAt(statusDir: string): number;
  /** When the cached PR set was fetched, 0 when there is no cache. */
  prsFetchedAt(statusDir: string): number;
  isQuiet(now: number): boolean;
  /** Rebuilds the page; returns why the GitHub read failed when the page was built from cached PRs, else undefined. */
  regenerate(statusDir: string, cachedPrsOnly: boolean): string | undefined;
}

const stamp = (path: string): string => { try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } };

const mtime = (path: string): number => { try { return statSync(path).mtimeMs; } catch { return 0; } };
/** The page's modification time; before the first Podium is written, the legacy NOW.md page that readPodium falls back to. */
const pageMtime = (dir: string): number => mtime(join(dir, PODIUM_FILE)) || mtime(join(dir, LEGACY_FILE));

export const realIo: RefreshIo = {
  ledgerSig: (statusDir) => {
    const project = CONFIGURED_PROJECT || CONTAINER_PROJECT;
    const root = join(LEDGER_ROOT || VAULT_ROOT, 'Projects', project);
    return [join(root, 'Journal', 'ledger.jsonl'), join(root, 'streams.json'), join(statusDir, 'priorities.md')].map(stamp).join('|');
  },
  prsDirtyAt,
  userEditAt: (dir) => {
    const page = readPodium(dir);
    const meta = readSeenMeta(dir);
    if (page === null || (meta !== null && meta.generated_sha === sha(page))) return null;
    return pageMtime(dir);
  },
  pageAt: pageMtime,
  prsFetchedAt: (dir) => readPrCache(dir)?.fetchedAt.getTime() ?? 0,
  isQuiet: (now) => 'stop' in nextInterval({ now, config: { quietHours: WATCH_QUIET_HOURS, quietMode: 'stop', quietWeekends: WATCH_QUIET_WEEKENDS, tz: WATCH_TZ } }),
  regenerate: (statusDir, cachedPrsOnly) => {
    const project = CONFIGURED_PROJECT || CONTAINER_PROJECT;
    return regenerate({ project, ledger: LEDGER_ROOT || VAULT_ROOT, statusDir, dryRun: false, snapshot: false, cachedPrsOnly }).prFailure;
  },
};

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

/** The state after noticing what changed since `prev`; a first check adopts the current signature as already seen. */
function observe(prev: StatusRefreshState | null, dir: string, now: number, io: RefreshIo): StatusRefreshState {
  const sig = io.ledgerSig(dir);
  const marker = io.prsDirtyAt(dir);
  const base: StatusRefreshState = prev ?? { sig, firstChange: 0, lastChange: 0, lastRun: io.pageAt(dir), markerSeen: marker, prDirty: false, retryAt: 0, error: '' };
  const changed = sig !== base.sig || marker > base.markerSeen;
  return {
    ...base, sig, markerSeen: marker, prDirty: base.prDirty || marker > base.markerSeen,
    firstChange: changed ? base.firstChange || now : base.firstChange, lastChange: changed ? now : base.lastChange,
  };
}

/** Whether a regeneration is due now, before the edit-quiet window and the retry delay are weighed. */
const due = (s: StatusRefreshState, now: number): boolean =>
  (s.firstChange > 0 && (now - s.lastChange >= SETTLE_MS || now - s.firstChange >= MAX_DELAY_MS)) || now - s.lastRun >= IDLE_MS;

export function check(target: string, ctx: Pick<CheckContext, 'now' | 'prev'>, io: RefreshIo = realIo): StatusRefreshState {
  const now = ctx.now;
  const prev = (ctx.prev as StatusRefreshState | null | undefined) ?? null;
  let state = prev;
  try {
    state = observe(prev, target, now, io);
    return attempt(target, now, state, io);
  } catch (e) {
    // Any failure, even a page that cannot be read, is retried later and reported as information: a throw would count towards the loop's "check keeps failing" event, which is actionable.
    const base = state ?? { sig: '', firstChange: 0, lastChange: 0, lastRun: now, markerSeen: 0, prDirty: false, retryAt: 0, error: '' };
    return { ...base, retryAt: now + RETRY_MS, error: firstLine(e) || 'unknown error' };
  }
}

function attempt(target: string, now: number, state: StatusRefreshState, io: RefreshIo): StatusRefreshState {
  if (!due(state, now) || now < state.retryAt) return state;
  const editedAt = io.userEditAt(target);
  if (editedAt !== null && now - editedAt < EDIT_QUIET_MS) return state;
  const fetchPrs = !io.isQuiet(now) && (state.prDirty || now - io.prsFetchedAt(target) >= PR_MAX_AGE_MS);
  const prFailure = io.regenerate(target, !fetchPrs);
  // A failed GitHub read leaves the PR data dirty, so the next waking-hours refresh tries again.
  return { ...state, firstChange: 0, lastChange: 0, lastRun: now, prDirty: state.prDirty && (!fetchPrs || !!prFailure), retryAt: 0, error: '' };
}

/** Silent unless a regeneration newly fails; even then the event is informational, so a refresh can never wake the orchestrator. */
export const diff = (prev: StatusRefreshState | null, next: StatusRefreshState): WatchEvent[] =>
  next.error && next.error !== prev?.error ? [{ summary: `status page refresh failed: ${next.error}`, actionable: false }] : [];
