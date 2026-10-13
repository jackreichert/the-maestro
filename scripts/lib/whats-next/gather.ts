/**
 * Everything `rankNext` reads, gathered from the files the loop already keeps current: every project's xenophon tickets and
 * `Board-rank.md` (through the guarded vault reader), the tracker snapshot, today's priorities and this week's goals, the offline
 * PR cache, and the open ledger items. Read-only. A source that is missing or unreadable contributes nothing rather than failing,
 * so the queue still ranks what it can see.
 */
import { existsSync } from 'node:fs';
import type { LedgerItem } from '../ledger-core.ts';
import { isInFlight, isOpen, isPendingDecision } from '../ledger-core.ts';
import { readPriorities } from '../status-page/priorities.ts';
import { readPrCache } from '../status-page/prcache.ts';
import { readWeek } from '../status-page/week.ts';
import { createReader } from '../vault/reader.ts';
import type { Scope } from '../vault/reader.ts';
import { loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import type { Goal, LedgerRef, PrRef, RankFile, RankInput } from './rank.ts';
import { parseRankFile } from './rank.ts';
import { readTracker } from './tracker.ts';

export const RANK_FILE = 'Board-rank.md';
const RANK_FILE_SCOPE: Scope = { name: 'rank file', pattern: /^Projects\/[^/]+\/Board-rank\.md$/ };
const RANK_FILE_MAX = 256 * 1024;

export interface GatherOptions {
  /** The vault holding `Projects/<p>/Tickets`; empty means no tickets. */
  vaultRoot: string;
  /** The status directory holding the tracker snapshot, priorities, week goals and PR cache; empty means none of them. */
  statusDir: string;
  /** Folded ledger items (open or not; only open ones are used). */
  items: LedgerItem[];
  /** Today's date in the user's zone, YYYY-MM-DD, for the priorities and week files. */
  today: string;
  frozenLabels: string[];
  blockedLabels: string[];
  now: Date;
}

const ref = (i: LedgerItem): LedgerRef => ({ id: String(i.id), text: String(i.text ?? ''), ...(typeof i.ticket === 'string' && i.ticket ? { ticket: i.ticket } : {}) });

/** Open ledger work that already holds an item: in flight, or blocked on the ledger. Queued work is not yet holding anything. */
export const inFlightRefs = (items: LedgerItem[]): LedgerRef[] => items.filter((i) => isInFlight(i) || (i.kind === 'blocked' && isOpen(i))).map(ref);
/** Open questions and pending decisions: an item one of them names is waiting on an answer. */
export const askRefs = (items: LedgerItem[]): LedgerRef[] => items.filter((i) => isOpen(i) && (i.kind === 'question' || isPendingDecision(i))).map(ref);

function goalsOf(statusDir: string, today: string): Goal[] {
  if (!statusDir || !existsSync(statusDir)) return [];
  const day = readPriorities(statusDir, today);
  const week = readWeek(statusDir, today);
  return [...(day.state === 'ok' ? day.items : []), ...(week.state === 'ok' ? week.items : [])];
}

function prsOf(statusDir: string): PrRef[] {
  const cache = statusDir ? readPrCache(statusDir) : null;
  return (cache?.prs ?? []).map((p) => ({ number: p.number, repo: p.repository.nameWithOwner, title: p.title, branch: p.headRefName, url: p.url }));
}

/** The tickets and each project's rank file, through the same guarded reader the home base uses. */
function vaultOf(vaultRoot: string): { tickets: RankInput['tickets']; rankFiles: Record<string, RankFile> } {
  if (!vaultRoot || !existsSync(vaultRoot)) return { tickets: [], rankFiles: {} };
  const reader = createReader({ root: vaultRoot, dirScopes: TICKET_DIR_SCOPES, fileScopes: [...TICKET_FILE_SCOPES, RANK_FILE_SCOPE] });
  const loaded = loadTickets(reader, 'whats-next');
  const rankFiles: Record<string, RankFile> = {};
  for (const project of loaded.projects) {
    const r = reader.read(`Projects/${project}/${RANK_FILE}`, RANK_FILE_MAX);
    if (r.ok) rankFiles[project] = parseRankFile(r.text);
  }
  return { tickets: loaded.tickets, rankFiles };
}

export function gatherRankInput(o: GatherOptions): RankInput {
  const { tickets, rankFiles } = vaultOf(o.vaultRoot);
  return {
    tickets, rankFiles,
    tracker: o.statusDir ? readTracker(o.statusDir) : null,
    goals: goalsOf(o.statusDir, o.today),
    prs: prsOf(o.statusDir),
    inFlight: inFlightRefs(o.items),
    asks: askRefs(o.items),
    frozenLabels: o.frozenLabels, blockedLabels: o.blockedLabels, now: o.now,
  };
}
