/** Reading the library index: ranked page lookup, one-hop neighbours and the text a hit prints as. The index tables are built by ledger-index.ts. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface FindOptions { repo?: string | null; kind?: string | null; component?: string | null; limit: number; includeSuperseded: boolean; neighbors: boolean }
export interface Neighbor { path: string; direction: 'links-to' | 'linked-from'; readWhen: string }
export interface FoundPage {
  path: string; repo: string; kind: string; title: string; readWhen: string; components: string[];
  status: string; verifiedAt: string; ageDays: number | null; stale: boolean; score: number;
  /** `all` when every word matched, `any` when the query only matched with its words OR-ed. */
  matched: 'all' | 'any';
  neighbors?: Neighbor[];
}

const NEIGHBOR_CAP = 5;
const DAY_MS = 86_400_000;
interface PageRow { path: string; repo: string; kind: string; title: string; read_when: string; components: string; status: string; verified_at: string; score: number }

/** Whole days between a `YYYY-MM-DD` date and `now`; null when the date is missing or not one. */
export function ageDays(verifiedAt: string, now: Date = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) return null;
  const t = Date.parse(`${verifiedAt}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

const STOPWORDS = new Set(['to', 'of', 'in', 'is', 'it', 'on', 'at', 'by', 'an', 'as', 'do', 'be', 'we', 'me', 'my', 'or', 'if', 'the', 'and', 'for', 'how', 'what', 'where', 'when', 'why', 'does', 'did', 'are', 'was', 'with', 'this', 'that', 'from', 'into', 'our', 'its', 'can', 'you', 'use', 'run', 'get']);
const MAX_WORDS = 12;

/** The query's plain words (no stop words, at most 12) joined with OR, or null when fewer than two remain (a retry would change nothing). */
export function anyWordQuery(query: string): string | null {
  const words = [...new Set((query.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((w) => !STOPWORDS.has(w.toLowerCase())))].slice(0, MAX_WORDS);
  return words.length > 1 ? words.map((w) => `"${w}"`).join(' OR ') : null;
}

/** Library pages matching an FTS5 expression, best first. Title, read-when and components outweigh the body. Superseded pages are left out unless asked for. */
export function findPages(db: DatabaseSync, match: string, o: FindOptions, matched: 'all' | 'any' = 'all', now: Date = new Date()): FoundPage[] {
  const where = ['library_fts MATCH ?'];
  const params: SQLInputValue[] = [match];
  if (o.repo) { where.push('l.repo = ?'); params.push(o.repo); }
  if (o.kind) { where.push('l.kind = ?'); params.push(o.kind); }
  if (o.component) { where.push("instr(',' || l.components || ',', ',' || ? || ',') > 0"); params.push(o.component); }
  if (!o.includeSuperseded) where.push("l.status != 'superseded'");
  const rows = db.prepare(`SELECT l.path, l.repo, l.kind, l.title, l.read_when, l.components, l.status, l.verified_at, bm25(library_fts, 5, 4, 3, 1) AS score
    FROM library_fts JOIN library l ON l.rowid = library_fts.rowid WHERE ${where.join(' AND ')} ORDER BY score, l.path LIMIT ?`).all(...params, o.limit) as unknown as PageRow[];
  return rows.map((r) => {
    const age = ageDays(r.verified_at, now);
    const page: FoundPage = {
      path: r.path, repo: r.repo, kind: r.kind, title: r.title, readWhen: r.read_when, components: r.components ? r.components.split(',') : [],
      status: r.status, verifiedAt: r.verified_at, ageDays: age, stale: r.status === 'stale', score: r.score, matched,
    };
    if (o.neighbors) page.neighbors = neighborsOf(db, r.path);
    return page;
  });
}

/** Pages one link away, in either direction, that are library pages: what the page links to first, then what links to it. */
export function neighborsOf(db: DatabaseSync, path: string): Neighbor[] {
  const out = db.prepare(`SELECT DISTINCT l.path, l.read_when FROM links k JOIN library l ON l.path = k.target_path WHERE k.src = ? AND l.path != ? ORDER BY l.path`).all(path, path) as unknown as { path: string; read_when: string }[];
  const into = db.prepare(`SELECT DISTINCT l.path, l.read_when FROM links k JOIN library l ON l.path = k.src WHERE k.target_path = ? AND l.path != ? ORDER BY l.path`).all(path, path) as unknown as { path: string; read_when: string }[];
  const seen = new Set<string>();
  return [...out.map((r) => ({ path: r.path, direction: 'links-to' as const, readWhen: r.read_when })), ...into.map((r) => ({ path: r.path, direction: 'linked-from' as const, readWhen: r.read_when }))]
    .filter((n) => (seen.has(n.path) ? false : (seen.add(n.path), true))).slice(0, NEIGHBOR_CAP);
}

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A hit as text: the path, kind and freshness on one line, the read-when line under it, neighbours under that. */
export function renderHit(h: FoundPage): string {
  const fresh = h.verifiedAt ? `verified ${h.verifiedAt}${h.ageDays === null ? '' : ` (${h.ageDays}d ago)`}` : 'not verified';
  return [
    `${h.path}  [${h.kind || 'no kind'}]  ${fresh}${h.stale ? '  STALE' : ''}${h.status === 'superseded' ? '  SUPERSEDED' : ''}`,
    `    Read when: ${h.readWhen ? clip(h.readWhen, 160) : '(none)'}`,
    ...(h.neighbors ?? []).map((n) => `    ${n.direction === 'links-to' ? '->' : '<-'} ${n.path}${n.readWhen ? `  ${clip(n.readWhen, 100)}` : ''}`),
  ].join('\n');
}
