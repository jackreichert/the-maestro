/**
 * retro-due: tells the orchestrator when agent retros are waiting for review, with no model involved. Target is the status directory (any
 * existing directory; the ledger is found from the configured project, as library-due finds it), one watch.
 *
 * Waiting is the `agent-retro` rows no `retro-reviewed` row has closed, plus the briefed items closed by `done` without a retro that no
 * review has seen (agent-retro.ts). The ledger is read only when its signature changes. A review is due when at least one is waiting and
 * either 10 or more are waiting, or 3 hours have passed since both the last review and the oldest waiting one: so retros are reviewed
 * every few hours in batches, never one by one. One actionable event per batch, then nothing until a new `retro-reviewed` row appears (a
 * review ran); if none appears within 3 hours the event is repeated once. A review's own rows never raise the waiting count, so it cannot
 * wake itself. The loop only reports it: the orchestrator dispatches the reviewer (playbooks/retro-review.md).
 * State { sig, pending, missing, oldestAt, lastReviewAt, reviewRows, announcedAt, announcedReviews, renudged, emitSeq }; times are epoch ms.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseLedger } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { missingRetros, pendingRetros } from '../lib/journal/agent-retro.ts';
import { stampAll } from '../lib/stamp.ts';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT } from '../local-config.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface RetroDueState {
  sig: string; pending: number; missing: number; oldestAt: number; lastReviewAt: number; reviewRows: number;
  announcedAt: number; announcedReviews: number; renudged: boolean; emitSeq: number;
}

export const interval = 60;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;

export const REVIEW_EVERY_MS = 3 * 3600_000;
export const BATCH = 10;
export const RENUDGE_MS = 3 * 3600_000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`retro-due target must be an existing directory (use the status directory), got "${target}"`);
}

/** What the check reads from the outside world; tests replace it. */
export interface RetroIo {
  /** Changes whenever the ledger file does. */
  ledgerSig(): string;
  readRows(): LedgerRow[];
}

const ledgerPath = (): string => join(LEDGER_ROOT || VAULT_ROOT, 'Projects', CONFIGURED_PROJECT || CONTAINER_PROJECT, 'Journal', 'ledger.jsonl');
export const realIo: RetroIo = {
  ledgerSig: () => stampAll([ledgerPath()]),
  readRows: () => { try { return parseLedger(readFileSync(ledgerPath(), 'utf8')); } catch { return []; } },
};

const ms = (iso: unknown): number => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };
const EMPTY: RetroDueState = { sig: '', pending: 0, missing: 0, oldestAt: 0, lastReviewAt: 0, reviewRows: 0, announcedAt: 0, announcedReviews: -1, renudged: false, emitSeq: 0 };

/** Folds the ledger into the counts the debounce needs. Run only when the signature changed. */
function fold(rows: LedgerRow[]): Pick<RetroDueState, 'pending' | 'missing' | 'oldestAt' | 'lastReviewAt' | 'reviewRows'> {
  const pending = pendingRetros(rows);
  const missing = missingRetros(rows);
  const times = [...pending.map((r) => ms(r.ts)), ...missing.map((m) => ms(m.closedAt))].filter((t) => t > 0);
  const reviews = rows.filter((r) => r.kind === 'retro-reviewed');
  return { pending: pending.length, missing: missing.length, oldestAt: times.length ? Math.min(...times) : 0, lastReviewAt: Math.max(0, ...reviews.map((r) => ms(r.ts))), reviewRows: reviews.length };
}

/** Whether a review is due now, from the stored counts alone. */
const due = (s: RetroDueState, now: number): boolean => {
  const waiting = s.pending + s.missing;
  return waiting >= 1 && (waiting >= BATCH || now - Math.max(s.lastReviewAt, s.oldestAt) >= REVIEW_EVERY_MS);
};

export function check(_target: string, ctx: Pick<CheckContext, 'now' | 'prev'>, io: RetroIo = realIo): RetroDueState {
  const now = ctx.now;
  const prev = (ctx.prev as RetroDueState | null | undefined) ?? null;
  const sig = io.ledgerSig();
  let s: RetroDueState = prev ?? { ...EMPTY };
  if (!prev || sig !== prev.sig) s = { ...s, ...fold(io.readRows()), sig };
  // A review ran since the announcement: the next batch is announced afresh.
  if (s.announcedAt && s.reviewRows !== s.announcedReviews) s = { ...s, announcedAt: 0, announcedReviews: -1, renudged: false };
  if (!due(s, now)) return s.pending + s.missing < 1 ? { ...s, announcedAt: 0, announcedReviews: -1, renudged: false } : s;
  if (!s.announcedAt) return { ...s, announcedAt: now, announcedReviews: s.reviewRows, renudged: false, emitSeq: s.emitSeq + 1 };
  if (!s.renudged && now - s.announcedAt >= RENUDGE_MS) return { ...s, renudged: true, emitSeq: s.emitSeq + 1 };
  return s;
}

const age = (msAgo: number): string => (msAgo >= 3600_000 ? `${Math.floor(msAgo / 3600_000)}h` : `${Math.max(1, Math.round(msAgo / 60_000))}m`);

/** One actionable line each time the state announced a batch since the last check. */
export function diff(prev: RetroDueState | null, next: RetroDueState): WatchEvent[] {
  if (next.emitSeq <= (prev?.emitSeq ?? 0)) return [];
  const missing = next.missing ? `, ${next.missing} briefed item${next.missing === 1 ? '' : 's'} closed without one` : '';
  const oldest = next.oldestAt ? `, oldest ${age(Math.max(0, next.announcedAt - next.oldestAt))}` : '';
  return [{ summary: `retro-due: ${next.pending} agent retro${next.pending === 1 ? '' : 's'} to review${missing}${oldest}`, actionable: true }];
}
