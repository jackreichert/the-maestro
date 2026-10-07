/**
 * The roll's check that the record shows what the day did to its epics: every open epic a ledger item touched today has a fresh
 * brief, and every note written today in that epic's projects names a ticket (or says `ticket: none`). It reads through the same
 * guarded reader, the same brief judge and the same fingerprint as the home base, so the two cannot disagree about "stale".
 * Read-only: it reports what is missing and writes nothing.
 */
import type { VaultReader } from '../vault/reader.ts';
import { buildForest, loadTickets } from '../vault/tickets.ts';
import type { Forest, Ticket } from '../vault/tickets.ts';
import { briefUnknown, forestBasis, judgeBrief, noteIndex, readBriefNote } from '../home/brief.ts';
import { DOC_FOLDERS, docHeader } from '../home/docs.ts';
import { subtree } from '../home/mapping.ts';

const HEAD_BYTES = 4096;
const MAX_DOC_BYTES = 1024 * 1024;
const FAILURE_CAP = 20;

export interface EpicBriefsInput {
  reader: VaultReader;
  /** The roll date, `YYYY-MM-DD`. */
  date: string;
  /** Ledger rows: the ticket each names and the day it was written. */
  rows: { id?: string; ticket?: string; date?: string }[];
  /** `ticket-map.json`: a ticket key to the ledger item ids it covers. */
  ticketMap: Record<string, string[]>;
  /** The vault-relative date of a file's mtime. */
  dateOf: (mtimeMs: number) => string;
  /** The cache key for parsed tickets. */
  cacheKey: string;
}
export interface EpicBriefsReport { epics: string[]; failures: string[] }

/** The top ancestor of a ticket, guarding against a parent loop. */
function rootOf(forest: Forest, id: string): string {
  const seen = new Set<string>();
  let cur = id;
  while (!seen.has(cur)) {
    seen.add(cur);
    const up = forest.parentOf.get(cur);
    if (!up || !forest.byId.has(up)) break;
    cur = up;
  }
  return cur;
}

/** Open epics touched on `date`, with a failure line for each fresh-brief or attribution gap. */
export function epicBriefsReport(inp: EpicBriefsInput): EpicBriefsReport {
  const forest = buildForest(loadTickets(inp.reader, inp.cacheKey).tickets);
  const mapped = new Map<string, string>();
  for (const [ticket, ids] of Object.entries(inp.ticketMap)) for (const id of ids) mapped.set(id, ticket);
  const touched = inp.rows.filter((r) => r.date === inp.date).map((r) => r.ticket ?? mapped.get(r.id ?? '')).filter((t): t is string => !!t && forest.byId.has(t));
  const epics = [...new Set(touched.map((t) => rootOf(forest, t)))].filter((id) => forest.children(id).length > 0 && forest.byId.get(id)?.status !== 'closed').sort();
  const failures: string[] = [];
  for (const id of epics) {
    const epic = forest.byId.get(id) as Ticket;
    const tree = subtree(forest, id);
    const projects = [...new Set(tree.map((t) => forest.byId.get(t)?.project).filter((p): p is string => !!p))].sort();
    const docs = projects.flatMap((p) => DOC_FOLDERS.flatMap((folder) => {
      const dir = `Projects/${p}/${folder}`;
      const ls = inp.reader.list(dir);
      return ls.ok ? ls.files.flatMap((f) => { const r = inp.reader.head(`${dir}/${f}`, HEAD_BYTES, MAX_DOC_BYTES); return r.ok ? [{ path: `${dir}/${f}`, mtime: r.mtimeMs, ...docHeader(r.text, f, folder) }] : []; }) : [];
    }));
    const brief = judgeBrief({
      epic: id, read: readBriefNote(inp.reader, epic.project, id), basis: forestBasis(forest, id),
      ticketDates: tree.map((t) => forest.byId.get(t)?.updated), docDates: docs.filter((d) => d.tickets.some((t) => tree.includes(t))).map((d) => d.updated),
      doneMeans: null, link: { vaultName: '', index: noteIndex([]) }, ref: { label: id },
    });
    const why = briefUnknown(id, brief);
    if (why) failures.push(why);
    const loose = docs.filter((d) => !d.tickets.length && !d.projectLevel && inp.dateOf(d.mtime) === inp.date);
    for (const d of loose.slice(0, 5)) failures.push(`${d.path} was written today in ${id}'s project and names no ticket. Run ticket.mjs attach <ticket> <note> --kind ${d.kind}, or add "ticket: none".`);
    if (loose.length > 5) failures.push(`${loose.length - 5} more notes written today in ${id}'s projects name no ticket.`);
  }
  return { epics, failures: failures.length > FAILURE_CAP ? [...failures.slice(0, FAILURE_CAP), `${failures.length - FAILURE_CAP} more.`] : failures };
}

/** The line the roll prints, or null when there is nothing to say. */
export const epicBriefsLines = (r: EpicBriefsReport): string[] => (r.failures.length ? [`Epic briefs and documents (${r.failures.length} to fix, ${r.epics.length} epic${r.epics.length === 1 ? '' : 's'} touched today):`, ...r.failures.map((f) => `  - ${f}`)] : []);
