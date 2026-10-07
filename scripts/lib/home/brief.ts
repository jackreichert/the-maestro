/**
 * The epic brief: one short note per epic at `Projects/<project>/Briefs/<epic-id>.md`, read through the guarded reader,
 * parsed here into a typed block tree (never Markdown, never HTML) and judged fresh or stale by a rule the code applies.
 *
 * Freshness is computed, never claimed. The brief's `basis` is a fingerprint of the epic when it was written (closed of total,
 * blocked count, epic status); the brief is stale when the fingerprint now differs, or when any ticket in the epic's tree or any
 * document attributed to it was updated after the brief's `updated` date. The fingerprint catches same-day changes a date cannot.
 * Every link is built here: only `http` and `https` addresses pass, and a `[[wikilink]]` becomes a link only when it names a
 * ticket or a document the reader already listed, exactly once; anything else stays plain text.
 */
import { obsidianUri } from '../status-page/links.ts';
import type { VaultReader } from '../vault/reader.ts';
import type { Scope } from '../vault/reader.ts';
import { isHttpUrl } from './config.ts';
import type { Block, EpicBrief, Inline, ListItem } from './types.ts';

export const BRIEF_DIR_SCOPES: readonly Scope[] = [{ name: 'brief folder', pattern: /^Projects\/[^/]+\/Briefs$/ }];
export const BRIEF_FILE_SCOPES: readonly Scope[] = [{ name: 'brief', pattern: /^Projects\/[^/]+\/Briefs\/[^/]+\.md$/ }];
export const MAX_BRIEF_BYTES = 8 * 1024;
const BLOCK_CAP = 200;
const RUN_CAP = 200;
const LINE_MAX = 2000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type BriefRead = { ok: true; text: string } | { ok: false; reason: 'missing' | 'too-large' | 'unreadable' };

/** The brief note of an epic, or why there is none. An id that is not a plain id has no brief and reads nothing. */
export function readBriefNote(reader: VaultReader, project: string, epic: string): BriefRead {
  if (!ID.test(epic) || !ID.test(project)) return { ok: false, reason: 'missing' };
  const r = reader.read(`Projects/${project}/Briefs/${epic}.md`, MAX_BRIEF_BYTES);
  if (r.ok) return { ok: true, text: r.text };
  return { ok: false, reason: r.reason === 'missing' || r.reason === 'denied' || r.reason === 'out-of-scope' ? 'missing' : r.reason === 'too-large' ? 'too-large' : 'unreadable' };
}

/** What the epic looked like when a brief was written, in the words the brief's `basis` field uses. */
export const basisOf = (e: { closed: number; total: number; blocked: number; status: string }): string => `closed ${e.closed} of ${e.total} · blocked ${e.blocked} · ${e.status}`;

// ── links ────────────────────────────────────────────────────────────────────

export interface NoteIndex {
  /** Resolve a wikilink target to a vault-relative path (no `.md`) or null when it is unknown or ambiguous. */
  resolve(target: string): string | null;
}
/** An index over ticket ids and the paths of documents already read. A base name shared by two notes resolves to nothing. */
export function noteIndex(notes: { id?: string; path: string }[]): NoteIndex {
  const byPath = new Set(notes.map((n) => n.path.replace(/\.md$/, '')));
  const byId = new Map<string, string | null>();
  const byBase = new Map<string, string | null>();
  const put = (m: Map<string, string | null>, key: string, path: string): void => { m.set(key, m.has(key) ? null : path); };
  for (const n of notes) {
    const path = n.path.replace(/\.md$/, '');
    if (n.id) put(byId, n.id, path);
    put(byBase, path.split('/').at(-1) as string, path);
  }
  return { resolve(target) { return byPath.has(target) ? target : byId.get(target) ?? byBase.get(target) ?? null; } };
}

interface LinkEnv { vaultName: string; index: NoteIndex }

// ── inline and block parsing ─────────────────────────────────────────────────

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LINE_MAX);
const INLINE = /!\[([^\]]*)\]\([^)]*\)|\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<![\w_])_([^_\s][^_]*)_(?![\w_])/g;

/** Inline runs of one line: bold, italic, code, http(s) links and resolvable wikilinks. Nothing nests; raw HTML and images are text. */
export function inlineRuns(line: string, env: LinkEnv): Inline[] {
  const text = clean(line);
  const runs: Inline[] = [];
  const plain = (t: string): void => { if (t) runs.push({ text: t }); };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (runs.length >= RUN_CAP) break;
    plain(text.slice(at, m.index));
    at = (m.index as number) + m[0].length;
    if (m[0].startsWith('![')) plain(m[1] ?? '');
    else if (m[2] !== undefined) {
      const path = env.vaultName ? env.index.resolve(m[2].trim()) : null;
      const label = (m[3] || m[2]).trim();
      runs.push(path ? { text: label, link: { url: obsidianUri(env.vaultName, path), kind: 'note' } } : { text: label });
    } else if (m[4] !== undefined) runs.push(isHttpUrl(m[5]) ? { text: m[4], link: { url: m[5] as string, kind: 'web' } } : { text: m[4] });
    else if (m[6] !== undefined) runs.push({ text: m[6], strong: true });
    else if (m[7] !== undefined) runs.push({ text: m[7], code: true });
    else runs.push({ text: (m[8] ?? m[9]) as string, em: true });
  }
  plain(text.slice(at));
  return runs;
}

const LIST_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * The blocks of a brief body. `#` is the title and is dropped; `##` becomes a level 3 heading and `###` a level 4 heading, so the
 * epic card's own headings stay above them; deeper headings are paragraphs. Code fences, tables and HTML are plain text lines.
 * The section "What done looks like" is replaced by `doneMeans`, the ticket's own text, so the brief never carries a second copy.
 */
export function parseBlocks(body: string, env: LinkEnv, doneMeans: string | null): Block[] {
  const blocks: Block[] = [];
  const lines = body.split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: ListItem[] } | null = null;
  let skipping = false;
  const flush = (): void => {
    if (para.length) blocks.push({ type: 'paragraph', runs: inlineRuns(para.join(' '), env) });
    if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    para = []; list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const depth = (h[1] as string).length;
      skipping = false;
      if (depth === 1) continue;
      const title = (h[2] as string).trim();
      if (depth <= 3) {
        if (/^what done looks like$/i.test(title)) {
          skipping = true;
          if (doneMeans) blocks.push({ type: 'heading', level: 3, runs: [{ text: 'What done looks like' }] }, { type: 'paragraph', runs: [{ text: clean(doneMeans) }] });
          continue;
        }
        blocks.push({ type: 'heading', level: depth === 2 ? 3 : 4, runs: inlineRuns(title, env) });
      } else blocks.push({ type: 'paragraph', runs: inlineRuns(title, env) });
      continue;
    }
    if (skipping) continue;
    if (!line.trim()) { flush(); continue; }
    const li = line.match(LIST_LINE);
    if (li) {
      const nested = (li[1] as string).length >= 2;
      const ordered = /^\s*\d/.test(line);
      if (para.length) flush();
      if (!list) list = { ordered, items: [] };
      const runs = inlineRuns(li[2] as string, env);
      const last = list.items.at(-1);
      if (nested && last) last.children.push({ runs }); else list.items.push({ runs, children: [] });
      continue;
    }
    if (line.startsWith('>')) { flush(); blocks.push({ type: 'quote', runs: inlineRuns(line.replace(/^>\s?/, ''), env) }); continue; }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks.slice(0, BLOCK_CAP);
}

// ── freshness ────────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}/;
const frontmatter = (text: string): { fm: Record<string, string>; body: string } => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm: Record<string, string> = {};
  for (const l of (m?.[1] ?? '').split('\n')) {
    const i = l.indexOf(':');
    if (i > 0 && !l.startsWith(' ')) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return { fm, body: m ? text.slice(m[0].length) : text };
};

export interface BriefInput {
  epic: string;
  read: BriefRead;
  /** The epic's counts now, for the fingerprint. */
  now: { closed: number; total: number; blocked: number; status: string };
  /** `updated` dates of the tickets in the epic's tree and of the documents attributed to it. */
  ticketDates: (string | undefined)[];
  docDates: (string | undefined)[];
  doneMeans: string | null;
  link: LinkEnv;
  /** The brief note's own link, when the vault name is known. */
  ref: { label: string; url?: string };
}

/** The brief of one epic: its state, why it is stale when it is, and the blocks to show. */
export function judgeBrief(inp: BriefInput): EpicBrief {
  if (!inp.read.ok) return { state: inp.read.reason === 'missing' ? 'missing' : inp.read.reason === 'too-large' ? 'too-long' : 'unreadable' };
  const { fm, body } = frontmatter(inp.read.text);
  const updated = DATE.test(fm.updated ?? '') ? (fm.updated as string).slice(0, 10) : undefined;
  const why: string[] = [];
  const nowBasis = basisOf(inp.now);
  if (!updated) why.push('the brief has no updated date');
  if (!fm.basis) why.push('the brief has no basis line to compare with');
  else if (fm.basis !== nowBasis) why.push(`the epic changed since it was written (then: ${fm.basis}; now: ${nowBasis})`);
  if (updated) {
    const later = (dates: (string | undefined)[]): number => dates.filter((d) => d && DATE.test(d) && d.slice(0, 10) > updated).length;
    const t = later(inp.ticketDates);
    const d = later(inp.docDates);
    if (t) why.push(`${t} ticket${t === 1 ? '' : 's'} updated after ${updated}`);
    if (d) why.push(`${d} document${d === 1 ? '' : 's'} updated after ${updated}`);
  }
  return { state: why.length ? 'stale' : 'fresh', ...(updated ? { updated } : {}), ...(why.length ? { staleBecause: why } : {}), ref: inp.ref, blocks: parseBlocks(body, inp.link, inp.doneMeans) };
}

/** The unknown a brief that is not fresh produces, with the fix in its sentence. Null for a fresh brief. */
export function briefUnknown(epic: string, b: EpicBrief): string | null {
  switch (b.state) {
    case 'fresh': return null;
    case 'missing': return `${epic} has no brief. Run ticket.mjs brief ${epic} and write it.`;
    case 'stale': return `${epic} brief is stale: ${(b.staleBecause ?? []).join('; ')}. Run ticket.mjs brief ${epic} --refresh and rewrite Status.`;
    case 'too-long': return `${epic} brief is longer than ${MAX_BRIEF_BYTES / 1024} KB, so it is not shown. A brief is short; cut it.`;
    default: return `${epic} brief could not be read.`;
  }
}
