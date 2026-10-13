/**
 * whats-next: keeps the ranked queue (`journal.ts next`) honest without anyone remembering to look, with no model involved. Target is
 * the status directory (where the tracker snapshot lives), one watch.
 *
 * Every tick ranks the queue the way `journal.ts next` does (lib/whats-next) and keeps two facts: the top item and when the tracker
 * snapshot was fetched. It raises:
 *   - one actionable line when a tracker snapshot exists and is older than 6 hours, once per snapshot (a fresh import resets it). No
 *     snapshot at all is silence: an install that tracks nothing outside the vault is never nagged;
 *   - one informational line when the top item changes (not on the first check, which only records it).
 * The loop only reports: the orchestrator runs playbooks/tracker-snapshot.md to refresh the snapshot.
 * State { top, topTitle, trackerAt, staleFor, staleHours, emitSeq, topSeq }; trackerAt and staleFor are the snapshot's ISO fetch time, staleHours its age when announced.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fold, parseLedger } from '../lib/ledger-core.ts';
import { localDate } from '../lib/status-page/priorities.ts';
import { gatherRankInput } from '../lib/whats-next/gather.ts';
import { rankNext } from '../lib/whats-next/rank.ts';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, NEXT_BLOCKED_LABELS, NEXT_FROZEN_LABELS, VAULT_ROOT, WATCH_TZ } from '../local-config.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface WhatsNextState { top: string; topTitle: string; trackerAt: string; staleFor: string; staleHours: number; emitSeq: number; topSeq: number }

export const interval = 300;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;

export const STALE_MS = 6 * 3600_000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`whats-next target must be an existing directory (use the status directory), got "${target}"`);
}

/** What the check reads from the outside world; tests replace it. */
export interface NextIo {
  /** The top of the ranked queue (id and title, or null when nothing is ready) and the tracker snapshot's fetch time (null when none). */
  rank(statusDir: string, now: number): { top: { id: string; title: string } | null; trackerAt: string | null };
}

const ledgerPath = (): string => join(LEDGER_ROOT || VAULT_ROOT, 'Projects', CONFIGURED_PROJECT || CONTAINER_PROJECT, 'Journal', 'ledger.jsonl');
export const realIo: NextIo = {
  rank(statusDir, now) {
    let rows: ReturnType<typeof parseLedger> = [];
    try { rows = parseLedger(readFileSync(ledgerPath(), 'utf8')); } catch { /* no ledger: nothing is in flight */ }
    const at = new Date(now);
    const r = rankNext(gatherRankInput({ vaultRoot: VAULT_ROOT, statusDir, items: fold(rows, null).items, today: localDate(at, WATCH_TZ), frozenLabels: NEXT_FROZEN_LABELS, blockedLabels: NEXT_BLOCKED_LABELS, now: at }));
    const top = r.ranked[0];
    return { top: top ? { id: top.id, title: top.title } : null, trackerAt: r.trackerFetchedAt };
  },
};

const EMPTY: WhatsNextState = { top: '', topTitle: '', trackerAt: '', staleFor: '', staleHours: 0, emitSeq: 0, topSeq: 0 };

export function check(target: string, ctx: Pick<CheckContext, 'now' | 'prev'>, io: NextIo = realIo): WhatsNextState {
  const prev = (ctx.prev as WhatsNextState | null | undefined) ?? null;
  const { top, trackerAt } = io.rank(target, ctx.now);
  let s: WhatsNextState = { ...(prev ?? EMPTY), top: top?.id ?? '', topTitle: top?.title ?? '', trackerAt: trackerAt ?? '' };
  if (prev && s.top !== prev.top) s = { ...s, topSeq: s.topSeq + 1 };
  const stale = !!trackerAt && ctx.now - Date.parse(trackerAt) > STALE_MS;
  if (stale && s.staleFor !== trackerAt) s = { ...s, staleFor: trackerAt, staleHours: Math.floor((ctx.now - Date.parse(trackerAt)) / 3600_000), emitSeq: s.emitSeq + 1 };
  return s;
}

/** The stale-snapshot line (actionable) and the new-top line (informational), each once per change. */
export function diff(prev: WhatsNextState | null, next: WhatsNextState): WatchEvent[] {
  const out: WatchEvent[] = [];
  if (next.emitSeq > (prev?.emitSeq ?? 0)) out.push({ summary: `whats-next: the tracker snapshot is ${next.staleHours}h old; refresh it (playbooks/tracker-snapshot.md)`, actionable: true });
  if (next.topSeq > (prev?.topSeq ?? 0)) out.push({ summary: next.top ? `whats-next: top of the queue is now ${next.top} (${next.topTitle.slice(0, 80)})` : 'whats-next: nothing is ready now (journal.ts next --all says why)', actionable: false });
  return out;
}
