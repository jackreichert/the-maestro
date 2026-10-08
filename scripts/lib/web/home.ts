/**
 * `GET /api/streams/:name/home`: the stream home base. The only disk reads are the guarded vault reader (tickets), the
 * optional `stream-homes.json` in the status directory, and what `readBoard` already reads (ledger, PR cache). Read-only.
 */
import { createReader } from '../vault/reader.ts';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES, loadDocs } from '../home/docs.ts';
import { loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { readHomes } from '../home/config.ts';
import { buildStreamHome } from '../home/build.ts';
import { BRIEF_DIR_SCOPES, BRIEF_FILE_SCOPES, readBriefNote } from '../home/brief.ts';
import type { LedgerFact } from '../home/build.ts';
import type { StreamHome } from '../home/types.ts';
import { readBoard } from './api.ts';
import { buildState as reduceState } from './state.ts';
import type { WebConfig } from './api.ts';
import { isOpen, isQueued } from '../ledger-core.ts';
import { activeStreams } from '../journal/board.ts';
import { readWeek } from '../status-page/week.ts';
import { buildForest } from '../vault/tickets.ts';
import { reachability } from '../notes/reachability.ts';
import type { ReachabilityReport } from '../notes/reachability.ts';
import type { LedgerItem } from '../ledger-core.ts';

const MAX_NAME = 200;

/** One fact per ledger item that names a ticket, directly or through `ticket-map.json`. */
function factsOf(items: LedgerItem[], ticketMap: Record<string, string[]>): LedgerFact[] {
  const mapped = new Map<string, string>();
  for (const [ticket, ids] of Object.entries(ticketMap)) for (const id of ids) mapped.set(id, ticket);
  return items.flatMap((i): LedgerFact[] => {
    const ticket = (typeof i.ticket === 'string' && i.ticket) || mapped.get(i.id ?? '');
    if (!ticket || !i.id) return [];
    const closed = i.closedBy?.kind;
    const state: LedgerFact['state'] = closed ? (closed === 'done' || closed === 'resolved' ? 'done' : 'other')
      : i.kind === 'wip' ? (isQueued(i) ? 'queued' : 'inflight') : i.kind === 'blocked' ? 'blocked'
        : (i.kind === 'question' || i.kind === 'decision') && isOpen(i) ? 'ask' : 'other';
    return [{ id: i.id, ticket, state, ...(i.stream ? { stream: i.stream } : {}) }];
  });
}

/** The home base of `name`, or null when `name` is not one of the board's streams. Nothing about the request reaches a path. */
export function buildHome(cfg: WebConfig, name: string, now: Date = new Date()): StreamHome | null {
  if (name.length > MAX_NAME) return null;
  const { inputs, g } = readBoard(cfg, now);
  const streams = reduceState(inputs).streams.filter((s) => s !== 'other');
  const canon = streams.find((s) => s === name);
  if (!canon) return null;
  const root = cfg.vaultRoot;
  const reader = root ? createReader({ root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES, ...BRIEF_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES, ...BRIEF_FILE_SCOPES] }) : null;
  const vault = root && reader ? loadTickets(reader, root) : null;
  return buildStreamHome({
    stream: canon, streams, now, vault, homes: readHomes(cfg.statusDir, streams), ledger: factsOf(g.items, inputs.ticketMap),
    readDocs: (project) => (reader ? loadDocs(reader, project) : { docs: [], notes: [] }),
    readBrief: (epic) => (reader ? readBriefNote(reader, epic.project, epic.id) : { ok: false, reason: 'missing' }),
    prs: inputs.prs, prData: { fetchedAt: inputs.prData.fetchedAt }, page: cfg.page,
  });
}

/**
 * The notes-reachability report for the streams with work open or planned (an open ledger item, a goal this week or a priority today),
 * read through the same board, forest, mapping, homes config and guarded reader as `buildHome`, so "listed" means what the tab lists.
 * Null when no vault root is set (nothing was read); `unreadable` carries what stopped the vault from being read. `since` is `YYYY-MM-DD`.
 */
export function notesReachability(cfg: WebConfig, since: string | undefined, now: Date = new Date()): { report: ReachabilityReport; unreadable: string[] } | null {
  const root = cfg.vaultRoot;
  if (!root) return null;
  const { inputs, g } = readBoard(cfg, now);
  const state = reduceState(inputs);
  const streams = state.streams.filter((s) => s !== 'other');
  const week = readWeek(cfg.statusDir, state.today);
  const planned = [...(state.priorities.state === 'ok' ? state.priorities.items : []), ...(week.state === 'ok' ? week.items : [])].map((p) => ({ stream: p.stream }));
  const active = activeStreams(g.inflight, g.queued, g.blocked, g.awaiting, g.paste, planned).filter((s) => streams.includes(s));
  const reader = createReader({ root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES] });
  const vault = loadTickets(reader, root);
  const unreadable = vault.issues.filter((i) => i.kind === 'unreadable-folder').map((i) => i.text);
  if (!vault.projects.length) unreadable.push('the vault has no readable Projects folder');
  const links = factsOf(g.items, inputs.ticketMap).filter((f) => f.stream && streams.includes(f.stream)).map((f) => ({ stream: f.stream as string, ticket: f.ticket }));
  const report = reachability({ streams, active, homes: readHomes(cfg.statusDir, streams), forest: buildForest(vault.tickets), links, docsOf: (project) => loadDocs(reader, project), ...(since ? { since } : {}) });
  return { report, unreadable };
}
