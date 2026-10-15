/**
 * The handover of one project, as a pure function of what the server has already read: its tickets, its documents, the text of its
 * `CONTEXT.md` and `INDEX.md`, the ledger facts and the open PRs. No file, clock or process access here.
 *
 * A section that cannot be filled says so (`state: 'missing'`) with the one-line fix; nothing is hidden and nothing is guessed.
 * Links are `obsidian://open` links the server builds, or http(s) PR links. No Markdown and no absolute path reaches the response.
 */
import type { Scope } from '../vault/reader.ts';
import { buildForest } from '../vault/tickets.ts';
import type { Forest, Ticket } from '../vault/tickets.ts';
import { obsidianUri } from '../status-page/links.ts';
import type { PageConfig, Pr } from '../status-page/render.ts';
import { subtree } from './mapping.ts';
import { prsNaming } from './prs.ts';
import { isHttpUrl } from './config.ts';
import type { Doc } from './docs.ts';
import type { LedgerFact } from './build.ts';
import type { Ref } from './types.ts';

/** The two project notes the handover reads whole: `CONTEXT.md` and the generated `INDEX.md`. `DOC_FILE_SCOPES` already admits the first; the second is added here so no other reader gains it. */
export const NOTE_FILE_SCOPES: readonly Scope[] = [{ name: 'project index', pattern: /^Projects\/[^/]+\/INDEX\.md$/ }];
export const NOTE_MAX_BYTES = 256 * 1024;

export const RUN_KINDS = ['setup', 'run', 'test', 'deploy'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface Missing { state: 'missing'; fix: string }
export interface NoteRow { title: string; ref: Ref; updated?: string }
export interface ProjectTicketRow { id: string; title: string; status: string; priority: number; ref: Ref }
export interface LibraryLine { title: string; kind: string; readWhen: string; verified: string; flag?: 'STALE' | 'SUPERSEDED'; ref?: Ref }

export interface ProjectHandover {
  project: string;
  overview: { state: 'ok'; summary: string; now: string[]; next: string[]; ref: Ref } | Missing;
  /** One entry per kind in `RUN_KINDS`, in that order; a kind with no tagged runbook is a `missing` entry, never left out. */
  run: ({ kind: RunKind; state: 'ok'; pages: NoteRow[] } | ({ kind: RunKind } & Missing))[];
  /** What stops work: blocked tickets, and the tickets with a question open for the owner. `clear` is true when there are none. */
  blocking: { clear: boolean; tickets: (ProjectTicketRow & { why: string })[]; moreTickets: number };
  work: { epics: { id: string; title: string; closed: number; total: number; ref: Ref }[]; open: ProjectTicketRow[]; openTotal: number; prs: Ref[]; prsMore: number };
  library: { state: 'ok'; groups: { kind: string; lines: LibraryLine[]; more: number }[] } | Missing;
  docs: { decisions: NoteRow | Missing; plans: NoteRow[]; shared: Missing };
}

export interface ProjectInput {
  project: string;
  tickets: Ticket[];
  docs: Doc[];
  ledger: LedgerFact[];
  prs: Pr[];
  page: PageConfig;
  /** The text of a project note (`CONTEXT.md`, `INDEX.md`) read through the guarded reader, or null when it cannot be read. */
  readNote?: (path: string) => string | null;
}

const OPEN_CAP = 15;
const BLOCK_CAP = 10;
const EPIC_CAP = 10;
const PLAN_CAP = 5;
const PR_CAP = 10;
const LINE_MAX = 300;
const LINES_MAX = 8;
const GROUP_CAP = 10;

const clip = (s: string, n = LINE_MAX): string => { const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const isOpen = (t: Ticket): boolean => t.status !== 'closed';

export function buildHandover(inp: ProjectInput): ProjectHandover {
  const { project, page } = inp;
  const note = (path: string): Ref | undefined => (page.vaultName ? { label: path.split('/').at(-1)?.replace(/\.md$/, '') ?? path, url: obsidianUri(page.vaultName, path.replace(/\.md$/, '')) } : undefined);
  const noteRow = (d: Doc): NoteRow => ({ title: d.title, ref: note(d.path) ?? { label: d.title }, ...(d.updated ?? d.modified ? { updated: (d.updated ?? d.modified) as string } : {}) });
  const forest = buildForest(inp.tickets);
  return {
    project,
    overview: overview(inp, note),
    run: RUN_KINDS.map((kind) => {
      const pages = inp.docs.filter((d) => (d.folder === 'Runbooks' || d.folder === 'Knowledge') && d.tags?.includes(kind)).map(noteRow);
      return pages.length ? { kind, state: 'ok' as const, pages } : { kind, state: 'missing' as const, fix: `No runbook tagged "${kind}". Add \`tags: [${kind}]\` to the page in Projects/${project}/Runbooks, or write one.` };
    }),
    blocking: blocking(inp, forest),
    work: work(inp, forest),
    library: library(inp, note),
    docs: {
      decisions: ((d) => (d ? noteRow(d) : { state: 'missing' as const, fix: `No DECISIONS.md in Projects/${project}. Record each decision with its reason there.` }))(inp.docs.find((x) => x.folder === 'DECISIONS')),
      plans: inp.docs.filter((d) => d.folder === 'Plans').sort(planOrder).slice(0, PLAN_CAP).map(noteRow),
      shared: { state: 'missing', fix: 'Documents handed over to the project are not recorded yet; add the important ones to `docs` or `pins` for the stream in stream-homes.json.' },
    },
  };
}

/** Active and in-review plans first, then the newest. */
function planOrder(a: Doc, b: Doc): number {
  const live = (d: Doc): number => (['active', 'in-review', 'review'].includes((d.status ?? '').toLowerCase()) ? 0 : 1);
  return live(a) - live(b) || (b.updated ?? b.modified ?? '').localeCompare(a.updated ?? a.modified ?? '') || a.path.localeCompare(b.path);
}

/** The text under a `## <heading>` of a note, up to the next `## `, as at most `LINES_MAX` clipped lines with list markers dropped. */
function sectionLines(text: string, heading: RegExp): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => heading.test(l));
  if (at === -1) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => clip(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))).filter(Boolean).slice(0, LINES_MAX);
}

/** The first paragraph of a note below its frontmatter and first heading. */
function firstParagraph(text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const para: string[] = [];
  for (const l of body.split('\n')) {
    if (/^#{1,6} /.test(l) && !para.length) continue;
    if (/^#{1,6} /.test(l) || (!l.trim() && para.length)) break;
    if (l.trim() && !/^(?:[-*>]|\d+\.)\s|^<!--|^\*\*Status\*\*/.test(l.trim()) && l.trim() !== '---') para.push(l.trim());
  }
  return clip(para.join(' '), 600);
}

function overview(inp: ProjectInput, note: (path: string) => Ref | undefined): ProjectHandover['overview'] {
  const path = `Projects/${inp.project}/CONTEXT.md`;
  const text = inp.readNote?.(path) ?? null;
  const summary = text ? firstParagraph(text) : '';
  if (!text || !summary) return { state: 'missing', fix: `Projects/${inp.project}/CONTEXT.md ${text === null ? 'is missing or unreadable' : 'has no opening paragraph'}. Write what the project is in one paragraph, then ## Now and ## Next.` };
  return { state: 'ok', summary, now: sectionLines(text, /^## Now\s*$/i), next: sectionLines(text, /^## Next\s*$/i), ref: note(path) ?? { label: 'CONTEXT' } };
}

function blocking(inp: ProjectInput, forest: Forest): ProjectHandover['blocking'] {
  const facts = new Map<string, LedgerFact[]>();
  for (const f of inp.ledger) facts.set(f.ticket, [...(facts.get(f.ticket) ?? []), f]);
  const found: (ProjectTicketRow & { why: string })[] = [];
  for (const t of inp.tickets.filter(isOpen)) {
    const open = (t.blockedBy ?? []).filter((b) => { const x = forest.byId.get(b); return x !== undefined && isOpen(x); });
    const why = t.status === 'blocked' ? 'status is blocked' : open.length ? `waiting on ${open.slice(0, 3).join(', ')}` : (facts.get(t.id) ?? []).some((f) => f.state === 'blocked') ? 'a ledger item is blocked'
      : (facts.get(t.id) ?? []).some((f) => f.state === 'ask') ? 'a question is waiting for an answer' : '';
    if (why) found.push({ ...ticketRow(inp.page, t), why });
  }
  found.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return { clear: found.length === 0, tickets: found.slice(0, BLOCK_CAP), moreTickets: Math.max(0, found.length - BLOCK_CAP) };
}

function ticketRow(page: PageConfig, t: Ticket): ProjectTicketRow {
  return { id: t.id, title: clip(t.title), status: t.status, priority: t.priority, ref: page.vaultName ? { label: t.id, url: obsidianUri(page.vaultName, t.path.replace(/\.md$/, '')) } : { label: t.id } };
}

function work(inp: ProjectInput, forest: Forest): ProjectHandover['work'] {
  const open = inp.tickets.filter(isOpen).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const epics = open.filter((t) => forest.children(t.id).length > 0).slice(0, EPIC_CAP).map((t) => {
    const below = subtree(forest, t.id).filter((x) => x !== t.id).map((x) => forest.byId.get(x) as Ticket);
    return { id: t.id, title: clip(t.title), closed: below.filter((b) => !isOpen(b)).length, total: below.length, ref: ticketRow(inp.page, t).ref };
  });
  const names = open.map((t) => t.id);
  const named = prsNaming(inp.prs.filter((p) => isHttpUrl(p.url)), names, PR_CAP);
  return { epics, open: open.slice(0, OPEN_CAP).map((t) => ticketRow(inp.page, t)), openTotal: open.length, prs: named.shown, prsMore: named.more };
}

/** The lines of the generated block of an INDEX.md: `- [[target]]: kind, read-when (verified DATE FLAG)`. Anything else in the file is ignored. */
const INDEX_LINE = /^- \[\[([^\]]+)\]\]: ([^,]*), (.*) \(verified ([^)]*?)(?: (STALE|SUPERSEDED))?\)$/;

function library(inp: ProjectInput, note: (path: string) => Ref | undefined): ProjectHandover['library'] {
  const path = `Projects/${inp.project}/INDEX.md`;
  const text = inp.readNote?.(path) ?? null;
  const fix = `Projects/${inp.project}/INDEX.md ${text === null ? 'is missing or unreadable' : 'lists no library pages'}. Run \`library-index.ts --repo ${inp.project}\` after the library pages exist.`;
  if (text === null) return { state: 'missing', fix };
  const start = text.indexOf('<!-- library-index:start -->');
  const end = text.indexOf('<!-- library-index:end -->');
  const block = start !== -1 && end > start ? text.slice(start, end) : text;
  const pages = inp.docs.filter((d) => d.folder === 'Knowledge' || d.folder === 'Runbooks');
  const byName = new Map(pages.map((d) => [d.path.split('/').at(-1)?.replace(/\.md$/, '') ?? '', d.path] as const));
  const groups = new Map<string, LibraryLine[]>();
  for (const raw of block.split('\n')) {
    const m = INDEX_LINE.exec(raw.trim());
    if (!m) continue;
    const target = (m[1] as string).split('|')[0] as string;
    const resolved = pages.find((d) => d.path.replace(/\.md$/, '') === target)?.path ?? byName.get(target);
    const ref = resolved ? note(resolved) : undefined;
    const kind = clip(m[2] as string, 40) || 'no kind';
    groups.set(kind, [...(groups.get(kind) ?? []), { title: clip(target.split('/').at(-1) as string, 120), kind, readWhen: clip(m[3] as string, 140), verified: clip(m[4] as string, 40), ...(m[5] ? { flag: m[5] as 'STALE' | 'SUPERSEDED' } : {}), ...(ref ? { ref } : {}) }]);
  }
  if (!groups.size) return { state: 'missing', fix };
  return { state: 'ok', groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([kind, lines]) => ({ kind, lines: lines.slice(0, GROUP_CAP), more: Math.max(0, lines.length - GROUP_CAP) })) };
}
