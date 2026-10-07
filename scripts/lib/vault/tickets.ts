/**
 * The ticket forest, in process. xenophon's `ticket.mjs` is the source of truth for what a ticket and a rollup are; this is
 * a port of its reader (`readTicket`, `pointsOf`, `buildForest`, `computeRollups`) so the web server never spawns it, and
 * `tickets-parity.test.ts` runs the real script on a fixture vault and asserts the numbers are the same. That parity is
 * held by the test suite, not at runtime.
 *
 * Tickets are read through the guarded reader from `Projects/<p>/Tickets/*.md` and `Projects/<p>/Tickets/Archive/*.md`
 * (the two folders xenophon scans). A note the reader refuses or that is not a ticket becomes an `Issue`, never an error.
 */
import type { Scope, VaultReader } from './reader.ts';

export const MAX_TICKET_BYTES = 256 * 1024;
export const MAX_TICKETS_PER_PROJECT = 5000;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CACHE_LIMIT = 10_000;

/** Folders the ticket reader is allowed to serve. */
export const TICKET_DIR_SCOPES: readonly Scope[] = [
  { name: 'projects', pattern: /^Projects$/ },
  { name: 'project', pattern: /^Projects\/[^/]+$/ },
  { name: 'tickets', pattern: /^Projects\/[^/]+\/Tickets$/ },
  { name: 'archive', pattern: /^Projects\/[^/]+\/Tickets\/Archive$/ },
];
export const TICKET_FILE_SCOPES: readonly Scope[] = [{ name: 'ticket note', pattern: /^Projects\/[^/]+\/Tickets\/(Archive\/)?[^/]+\.md$/ }];

export interface Ticket {
  id: string; title: string; status: string; type: string; priority: number;
  labels: string[]; blockedBy: string[]; parent?: string; external?: string;
  created?: string; updated?: string; closed?: string;
  /** Story points from `## Estimate`; 0 when absent. */
  points: number;
  /** Vault-relative path of the note, and the project folder it sits in. */
  path: string; project: string; archived: boolean;
  body: string;
}
/** Something the home base could not read or understand; shown as an unknown, with a vault-relative path and no secret name. */
export interface Issue { kind: 'unreadable-note' | 'not-a-ticket' | 'too-many-notes' | 'unreadable-folder' | 'parent-cycle'; text: string; path?: string }
export interface Rollup { total: number; direct: number; closed: number; blocked: number; ptsTotal: number; ptsDone: number }

// ── parsing (a port of ticket.mjs) ──────────────────────────────────────────

type Scalar = string | number | boolean | string[];
function parseScalar(raw: string): Scalar {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
  }
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

const str = (v: Scalar | undefined): string | undefined => (v === undefined || v === '' ? undefined : String(v));
const list = (v: Scalar | undefined): string[] => (Array.isArray(v) ? v : []);

/** The `## Estimate` points of a body: `N story point(s)` directly under the heading; 0 when absent. Written without overlapping quantifiers: the ticket tool's own pattern is cubic on a long run of blank lines. */
export const pointsOf = (body: string): number => Number(body.match(/^## Estimate[ \t]*\n(?:[ \t]*\n)*[ \t]*(\d+) story points?/m)?.[1] ?? 0);

/** A ticket from a note's text, or null when it has no frontmatter or no id. */
export function parseTicket(text: string, path: string): Ticket | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm: Record<string, Scalar> = {};
  for (const line of (m[1] as string).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1 || line.startsWith(' ')) continue;
    fm[line.slice(0, i).trim()] = parseScalar(line.slice(i + 1));
  }
  const id = str(fm.id);
  if (!id) return null;
  const body = text.slice(m[0].length);
  const segs = path.split('/');
  return {
    id, title: str(fm.title) ?? id, status: str(fm.status) ?? 'open', type: str(fm.type) ?? 'task',
    priority: typeof fm.priority === 'number' ? fm.priority : 3,
    labels: list(fm.labels), blockedBy: list(fm['blocked-by']), parent: str(fm.parent), external: str(fm.external),
    created: str(fm.created), updated: str(fm.updated), closed: str(fm.closed),
    points: pointsOf(body), path, project: segs[1] as string, archived: segs.at(-2) === 'Archive', body,
  };
}

// ── loading ─────────────────────────────────────────────────────────────────

/** Parsed notes by path, valid while the file's mtime and size are unchanged. Bounded: the oldest entries go first. */
const parsed = new Map<string, { sig: string; ticket: Ticket | null }>();
function remember(key: string, sig: string, ticket: Ticket | null): void {
  parsed.delete(key);
  parsed.set(key, { sig, ticket });
  while (parsed.size > CACHE_LIMIT) parsed.delete(parsed.keys().next().value as string);
}

export interface Loaded { tickets: Ticket[]; issues: Issue[]; projects: string[]; newestMtime: number }

/** Every ticket of every project in the vault, sorted by id as ticket.mjs sorts them. Directory listings are read on every call; parsed notes are cached by mtime and size. */
export function loadTickets(reader: VaultReader, cacheKey: string): Loaded {
  const out: Ticket[] = [];
  const issues: Issue[] = [];
  let newest = 0;
  const top = reader.list('Projects');
  const projects = top.ok ? top.dirs.filter((d) => PROJECT_NAME.test(d)) : [];
  if (!top.ok && top.reason !== 'missing') issues.push({ kind: 'unreadable-folder', text: 'Projects: cannot be read', path: 'Projects' });
  for (const project of projects) {
    for (const dir of [`Projects/${project}/Tickets`, `Projects/${project}/Tickets/Archive`]) {
      const ls = reader.list(dir);
      if (!ls.ok) { if (ls.reason !== 'missing' && ls.reason !== 'denied') issues.push({ kind: 'unreadable-folder', text: `${dir}: ${ls.reason}`, path: dir }); continue; }
      const names = ls.files.filter((f) => f !== '_Index.md');
      if (names.length > MAX_TICKETS_PER_PROJECT) issues.push({ kind: 'too-many-notes', text: `${dir}: ${names.length} notes; only the first ${MAX_TICKETS_PER_PROJECT} are read`, path: dir });
      for (const name of names.slice(0, MAX_TICKETS_PER_PROJECT)) {
        const path = `${dir}/${name}`;
        const r = reader.read(path, MAX_TICKET_BYTES);
        if (!r.ok) { if (r.reason !== 'denied' && r.reason !== 'missing') issues.push({ kind: 'unreadable-note', text: `${path}: ${r.reason}`, path }); continue; }
        newest = Math.max(newest, r.mtimeMs);
        const key = `${cacheKey}\0${path}`;
        const sig = `${r.mtimeMs}:${r.size}`;
        const hit = parsed.get(key);
        const ticket = hit && hit.sig === sig ? hit.ticket : parseTicket(r.text, path);
        if (!hit || hit.sig !== sig) remember(key, sig, ticket);
        if (ticket) out.push(ticket); else issues.push({ kind: 'not-a-ticket', text: `${path}: no frontmatter id`, path });
      }
    }
  }
  return { tickets: out.sort((a, b) => a.id.localeCompare(b.id)), issues, projects, newestMtime: newest };
}

// ── forest and rollups (a port of buildForest / computeRollups) ─────────────

export interface Forest {
  byId: Map<string, Ticket>;
  parentOf: Map<string, string>;
  children(id: string): Ticket[];
  roll(id: string): Rollup;
  /** Parent ids hand-edited into a loop; the closing edge of each is ignored. */
  cycles: string[];
}

const byPriorityThenId = (a: Ticket, b: Ticket): number => (a.priority - b.priority) || a.id.localeCompare(b.id);

export function buildForest(tickets: Ticket[]): Forest {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const parentOf = new Map<string, string>();
  for (const [id, t] of byId) if (t.parent && t.parent !== id && byId.has(t.parent)) parentOf.set(id, t.parent);

  const cycles: string[] = [];
  const done = new Set<string>();
  for (const start of [...parentOf.keys()].sort()) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !done.has(cur) && !path.includes(cur)) { path.push(cur); cur = parentOf.get(cur); }
    if (cur !== undefined && !done.has(cur)) {
      const loop = path.slice(path.indexOf(cur));
      cycles.push([...loop, cur].join(' -> '));
      parentOf.delete(loop.at(-1) as string);
    }
    path.forEach((id) => done.add(id));
  }

  const kids = new Map<string, Ticket[]>();
  for (const [id, p] of parentOf) { const l = kids.get(p) ?? []; l.push(byId.get(id) as Ticket); kids.set(p, l); }
  for (const l of kids.values()) l.sort(byPriorityThenId);

  const order = [...byId.values()].filter((t) => !parentOf.has(t.id));
  for (let i = 0; i < order.length; i++) order.push(...(kids.get((order[i] as Ticket).id) ?? []));
  const rolls = new Map<string, Rollup>();
  for (const t of order.toReversed()) {
    const r: Rollup = { total: 0, direct: 0, closed: 0, blocked: 0, ptsTotal: 0, ptsDone: 0 };
    for (const c of kids.get(t.id) ?? []) {
      const cr = rolls.get(c.id) as Rollup;
      const closed = c.status === 'closed';
      r.direct += 1;
      r.total += 1 + cr.total;
      r.closed += (closed ? 1 : 0) + cr.closed;
      r.blocked += (c.status === 'blocked' ? 1 : 0) + cr.blocked;
      r.ptsTotal += c.points + cr.ptsTotal;
      r.ptsDone += (closed ? c.points : 0) + cr.ptsDone;
    }
    rolls.set(t.id, r);
  }
  const empty: Rollup = { total: 0, direct: 0, closed: 0, blocked: 0, ptsTotal: 0, ptsDone: 0 };
  return { byId, parentOf, children: (id) => kids.get(id) ?? [], roll: (id) => rolls.get(id) ?? empty, cycles };
}
