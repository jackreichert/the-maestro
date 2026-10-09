/**
 * Which durable notes can nobody find from a stream's home? A pure reducer over what the home base already reads (the ticket
 * forest, the ticket-to-stream mapping, `stream-homes.json`, each project's documents), so "listed" here means what the tab lists.
 *
 * Scope: the notes in the projects of every active stream (an open ledger item, or named in this week's goals or today's priorities).
 * A project is a stream's when `stream-homes.json` lists it for the stream or a ticket tree the stream claims lives there.
 * A note is reachable when any rule below says so, tried in order, the first with an opinion deciding:
 *   1. it is a project's CONTEXT or DECISIONS (found by folder, always listed)
 *   2. a stream pins it (`docs`, `runbooks` or a pin's `note`)
 *   3. its `stream:` field names a known stream, or `none` together with `ticket: none` (kept off every tab on purpose)
 *   4. it names a ticket in a claimed tree
 * Anything else is unreachable, with the reason and the one-line fix. Nothing here reads a file, the clock or a process.
 */
import { mapUnits, subtree } from '../home/mapping.ts';
import type { LedgerLink } from '../home/mapping.ts';
import type { Doc, Docs } from '../home/docs.ts';
import type { Homes } from '../home/config.ts';
import type { Forest } from '../vault/tickets.ts';

export interface ReachabilityInput {
  /** Every stream the board knows, `other` excluded. */
  streams: string[];
  /** The streams with work open or planned: the scope of the check. */
  active: string[];
  homes: Homes;
  forest: Forest;
  links: LedgerLink[];
  /** The documents of one project; called only for the projects of an active stream. */
  docsOf: (project: string) => Docs;
  /** Only notes dated on or after this day (`YYYY-MM-DD`) are checked. A note's date is its frontmatter date, else the day its file was last written; a note with neither is always checked. */
  since?: string;
}
export interface Unreachable { path: string; project: string; streams: string[]; reason: string; fix: string }
export interface ReachabilityReport {
  active: string[];
  checked: number;
  unreachable: Unreachable[];
  /** Unreachable notes per active stream; a note in a project two streams share counts for both. */
  byStream: Record<string, number>;
  /** What could not be read, one line each. */
  notes: string[];
  /** The window the check ran with (`YYYY-MM-DD`): older notes were left alone. Absent when every note was checked. */
  since?: string;
}

interface Ctx { known: Set<string>; owner: Map<string, string[]>; forest: Forest; pinned: Set<string> }
/** `true` reachable, a string unreachable (the reason), null no opinion. */
type Verdict = true | string | null;
const RULES: ((d: Doc, c: Ctx) => Verdict)[] = [
  (d) => (d.folder === 'CONTEXT' || d.folder === 'DECISIONS' ? true : null),
  (d, c) => (c.pinned.has(d.path) ? true : null),
  (d, c) => {
    if (d.stream === undefined) return null;
    if (d.stream.toLowerCase() === 'none') return d.projectLevel ? true : 'says `stream: none` but not `ticket: none`, so it is off every tab by accident';
    return c.known.has(d.stream) ? true : `its stream "${d.stream}" is not a known stream (known: ${[...c.known].sort().join(', ') || 'none'})`;
  },
  (d, c) => {
    if (!d.tickets.length) return 'names no ticket and no stream';
    if (d.tickets.some((t) => (c.owner.get(t) ?? []).length === 1)) return true;
    const ambiguous = d.tickets.map((t) => c.owner.get(t) ?? []).find((s) => s.length > 1);
    if (ambiguous) return `its ticket is ambiguous between ${ambiguous.join(' and ')}`;
    return d.tickets.some((t) => c.forest.byId.has(t)) ? 'its ticket is in no stream' : 'names a ticket that is not in the vault';
  },
];

/** Ticket id -> the streams whose claimed trees hold it (one stream, or several when the unit is ambiguous). */
function ownersOf(forest: Forest, homes: Homes, streams: string[], links: LedgerLink[]): { owner: Map<string, string[]>; claimedProjects: Map<string, Set<string>> } {
  const mapping = mapUnits(forest, homes, streams, links);
  const nested = new Set(mapping.units.filter((u) => forest.parentOf.has(u)));
  const owner = new Map<string, string[]>();
  const claimedProjects = new Map<string, Set<string>>();
  const put = (id: string, ss: string[]): void => { owner.set(id, ss); for (const s of ss) { const p = forest.byId.get(id)?.project; if (p) claimedProjects.set(s, (claimedProjects.get(s) ?? new Set()).add(p)); } };
  for (const [unit, c] of mapping.claims) for (const id of subtree(forest, unit, nested)) put(id, [c.stream]);
  for (const [unit, a] of mapping.ambiguous) for (const id of subtree(forest, unit, nested)) if (!owner.has(id)) put(id, a.streams);
  return { owner, claimedProjects };
}

const fixOf = (d: Doc, owners: string[]): string => {
  const stream = owners.length === 1 ? owners[0] : '<Stream>';
  return `add "stream: ${stream}" to its frontmatter (or "stream: none" with "ticket: none" to keep it off every tab), or run ticket.mjs attach <ticket> ${d.path} --kind ${d.kind}`;
};

/**
 * The window setting as a start day: `30d` (days back from `now`), a `YYYY-MM-DD` on or before `now`'s UTC day, or `all` (no window, undefined).
 * A future date, an `Nd` above 3660, or anything else is null, so a caller can name the bad value instead of checking a nonsense span.
 */
export function windowStart(raw: string, now: Date = new Date()): string | undefined | null {
  const v = raw.trim().toLowerCase();
  if (v === 'all') return undefined;
  const days = v.match(/^(\d+)d$/);
  if (days) {
    const n = Number(days[1]);
    // Cap: an Nd above 3660 days is a misconfiguration, not a window.
    if (n > 3660) return null;
    return new Date(now.getTime() - n * 864e5).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return v <= now.toISOString().slice(0, 10) ? v : null;
}

export function reachability(inp: ReachabilityInput): ReachabilityReport {
  const { owner, claimedProjects } = ownersOf(inp.forest, inp.homes, inp.streams, inp.links);
  const known = new Set([...inp.streams, ...Object.keys(inp.homes.streams)]);
  const pinned = new Set(Object.values(inp.homes.streams).flatMap((s) => [...s.docs, ...s.runbooks, ...s.pins.flatMap((p) => ('note' in p ? [p.note] : []))]));
  const ctx: Ctx = { known, owner, forest: inp.forest, pinned };
  const projectStreams = new Map<string, string[]>();
  for (const s of inp.active) for (const p of new Set([...(inp.homes.streams[s]?.projects ?? []), ...(claimedProjects.get(s) ?? [])])) projectStreams.set(p, [...(projectStreams.get(p) ?? []), s]);
  const unreachable: Unreachable[] = [];
  const notes: string[] = [];
  let checked = 0;
  for (const [project, owners] of [...projectStreams].sort(([a], [b]) => a.localeCompare(b))) {
    const { docs, notes: unread } = inp.docsOf(project);
    notes.push(...unread);
    for (const d of docs) {
      const dated = d.updated ?? d.modified;
      if (inp.since && dated && dated.slice(0, 10) < inp.since) continue;
      checked += 1;
      const reason = RULES.map((r) => r(d, ctx)).find((v) => v !== null);
      if (reason !== true) unreachable.push({ path: d.path, project, streams: owners, reason: reason ?? 'is listed on no tab', fix: fixOf(d, owners) });
    }
  }
  const byStream: Record<string, number> = Object.fromEntries(inp.active.map((s) => [s, 0]));
  for (const u of unreachable) for (const s of u.streams) byStream[s] = (byStream[s] ?? 0) + 1;
  return { active: inp.active, checked, unreachable, byStream, notes, ...(inp.since ? { since: inp.since } : {}) };
}

/** The lines `notes-check` and the roll print: a header with the counts, then one line per note (at most `max`), each with its fix. */
export function reachabilityLines(r: ReachabilityReport, max = 20): string[] {
  const by = Object.entries(r.byStream).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(', ');
  const head = `Notes reachability: ${r.unreachable.length} of ${r.checked} notes (in the projects of ${r.active.length} active stream${r.active.length === 1 ? '' : 's'}) are listed on no stream tab${by ? ` (${by})` : ''}${r.since ? `; notes dated before ${r.since} are left alone (notes-check --all lists every note)` : ''}.`;
  if (!r.unreachable.length) return [head, ...r.notes.map((n) => `  unread: ${n}`)];
  const rows = r.unreachable.slice(0, max).flatMap((u) => [`  - ${u.path}: ${u.reason}.`, `      fix: ${u.fix}`]);
  return [head, ...rows, ...(r.unreachable.length > max ? [`  … +${r.unreachable.length - max} more (journal.ts notes-check lists all)`] : []), ...r.notes.map((n) => `  unread: ${n}`)];
}
