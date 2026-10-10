/**
 * library-due: tells the orchestrator when learned rows are waiting to be composed into library pages, with no model involved. Target is the
 * status directory (any existing directory; the ledger is found from the configured project, as status-refresh finds it), one watch.
 *
 * Pending is the learned rows no `curated` row has closed (composer.ts: the closing fold is the cursor, there is no cursor file). The ledger
 * is read only when its signature changes; the debounce below runs on the stored counts, so a quiet tick costs one stat. Due means no live
 * `library:composer` lease, at least one pending row, and one of:
 *   - the ledger has been quiet for 10 minutes and the last pass began 30 or more minutes ago (or there never was one);
 *   - 8 or more rows are pending;
 *   - a `rolled` row is newer than both the last pass and the oldest pending row (a roll carries them).
 * One actionable event is emitted per batch, then nothing until a new `lease` row on `library:composer` appears (a pass began); if no pass
 * began within 2 hours the event is repeated once. `curated` and lease rows change the signature but never raise the pending count, so
 * a composer pass cannot wake itself. The event is unowned (no `repo`). The loop only reports it: the orchestrator dispatches the composer.
 * State { sig, pending, byRepo, oldestAt, lastChange, lastPassAt, liveUntil, leaseRows, rolledSince, announcedAt, announcedLeases, renudged, emitSeq }; times are epoch ms.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseLedger } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { COMPOSER_ITEM, composerLease, pendingLearned } from '../lib/library/composer.ts';
import { stampAll } from '../lib/stamp.ts';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT } from '../local-config.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface LibraryDueState {
  sig: string; pending: number; byRepo: Record<string, number>; oldestAt: number; lastChange: number; lastPassAt: number; liveUntil: number;
  leaseRows: number; rolledSince: boolean; announcedAt: number; announcedLeases: number; renudged: boolean; emitSeq: number;
}

export const interval = 60;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;

export const QUIET_MS = 10 * 60_000;
export const PASS_FLOOR_MS = 30 * 60_000;
export const BATCH_ROWS = 8;
export const RENUDGE_MS = 2 * 3600_000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`library-due target must be an existing directory (use the status directory), got "${target}"`);
}

/** What the check reads from the outside world; tests replace it. */
export interface DueIo {
  /** Changes whenever the ledger file does. */
  ledgerSig(): string;
  readRows(): LedgerRow[];
}

const ledgerPath = (): string => join(LEDGER_ROOT || VAULT_ROOT, 'Projects', CONFIGURED_PROJECT || CONTAINER_PROJECT, 'Journal', 'ledger.jsonl');
export const realIo: DueIo = {
  ledgerSig: () => stampAll([ledgerPath()]),
  readRows: () => { try { return parseLedger(readFileSync(ledgerPath(), 'utf8')); } catch { return []; } },
};

const ms = (iso: string | undefined): number => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };
const EMPTY: LibraryDueState = { sig: '', pending: 0, byRepo: {}, oldestAt: 0, lastChange: 0, lastPassAt: 0, liveUntil: 0, leaseRows: 0, rolledSince: false, announcedAt: 0, announcedLeases: -1, renudged: false, emitSeq: 0 };

/** Folds the ledger into the counts the debounce needs. Run only when the signature changed. */
function fold(rows: LedgerRow[], now: number): Pick<LibraryDueState, 'pending' | 'byRepo' | 'oldestAt' | 'lastPassAt' | 'liveUntil' | 'leaseRows' | 'rolledSince'> {
  const pending = pendingLearned(rows);
  const byRepo: Record<string, number> = {};
  for (const r of pending) { const k = typeof r.repo === 'string' && r.repo ? r.repo : 'unowned'; byRepo[k] = (byRepo[k] ?? 0) + 1; }
  const oldestAt = pending.length ? Math.min(...pending.map((r) => ms(r.ts as string))) : 0;
  const lease = composerLease(rows, now);
  const lastPassAt = ms(lease.lastPassAt);
  const rolledSince = pending.length > 0 && rows.some((r) => r.kind === 'rolled' && ms(r.ts as string) > Math.max(lastPassAt, oldestAt));
  const leaseRows = rows.filter((r) => r.kind === 'lease' && r.leases === COMPOSER_ITEM).length;
  return { pending: pending.length, byRepo, oldestAt, lastPassAt, liveUntil: lease.live ? lease.live.until : 0, leaseRows, rolledSince };
}

/** Whether a batch is ready now, from the stored counts alone. */
const due = (s: LibraryDueState, now: number): boolean => {
  if (s.pending < 1 || now < s.liveUntil) return false;
  return s.pending >= BATCH_ROWS || s.rolledSince || (now - s.lastChange >= QUIET_MS && now - s.lastPassAt >= PASS_FLOOR_MS);
};

export function check(_target: string, ctx: Pick<CheckContext, 'now' | 'prev'>, io: DueIo = realIo): LibraryDueState {
  const now = ctx.now;
  const prev = (ctx.prev as LibraryDueState | null | undefined) ?? null;
  const sig = io.ledgerSig();
  let s: LibraryDueState = prev ?? { ...EMPTY, sig: '' };
  if (!prev || sig !== prev.sig) s = { ...s, ...fold(io.readRows(), now), sig, lastChange: prev ? now : 0 };
  // A lease that has lapsed since the last fold no longer suppresses; liveUntil carries that without a re-read.
  if (s.announcedAt && s.leaseRows !== s.announcedLeases) s = { ...s, announcedAt: 0, announcedLeases: -1, renudged: false };
  if (!due(s, now)) return s.pending < 1 ? { ...s, announcedAt: 0, announcedLeases: -1, renudged: false } : s;
  if (!s.announcedAt) return { ...s, announcedAt: now, announcedLeases: s.leaseRows, renudged: false, emitSeq: s.emitSeq + 1 };
  if (!s.renudged && now - s.announcedAt >= RENUDGE_MS) return { ...s, renudged: true, emitSeq: s.emitSeq + 1 };
  return s;
}

const hours = (ms: number): string => (ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);

/** One actionable line each time the state announced a batch since the last check; the age is of the oldest pending row at that tick. */
export function diff(prev: LibraryDueState | null, next: LibraryDueState): WatchEvent[] {
  if (next.emitSeq <= (prev?.emitSeq ?? 0)) return [];
  const repos = Object.entries(next.byRepo).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r, n]) => `${r} ${n}`).join(', ');
  const age = next.oldestAt ? `, oldest ${hours(Math.max(0, next.announcedAt - next.oldestAt))}` : '';
  return [{ summary: `library-due: ${next.pending} learned to compose (${repos})${age}`, actionable: true }];
}
