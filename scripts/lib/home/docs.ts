/**
 * Project documents for the link rail: `CONTEXT.md`, `DECISIONS.md` and the `*.md` files inside Plans, Research, Reviews and
 * Runbooks, and inside one level of subfolder under each (`Research/notion-acme/x.md`); deeper folders are not read. Only the first 4 KB of each is read (frontmatter and first heading), through the guarded reader.
 */
import type { Scope, VaultReader } from '../vault/reader.ts';

export const DOC_FOLDERS = ['Plans', 'Research', 'Reviews', 'Runbooks'] as const;
export type DocFolder = 'CONTEXT' | 'DECISIONS' | (typeof DOC_FOLDERS)[number];
export const DOC_DIR_SCOPES: readonly Scope[] = [{ name: 'doc folder', pattern: /^Projects\/[^/]+\/(Plans|Research|Reviews|Runbooks)(\/[^/]+)?$/ }];
export const DOC_FILE_SCOPES: readonly Scope[] = [
  { name: 'project doc', pattern: /^Projects\/[^/]+\/(CONTEXT|DECISIONS)\.md$/ },
  { name: 'folder doc', pattern: /^Projects\/[^/]+\/(Plans|Research|Reviews|Runbooks)(\/[^/]+)?\/[^/]+\.md$/ },
];

const HEAD_BYTES = 4096;
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_DOCS_PER_PROJECT = 500;
const MAX_SUBFOLDERS = 20;
const TITLE_MAX = 120;

export const DOC_KINDS = ['brief', 'plan', 'research', 'review', 'runbook', 'uat', 'decision', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
const FOLDER_KIND: Record<DocFolder, DocKind> = { CONTEXT: 'other', DECISIONS: 'decision', Plans: 'plan', Research: 'research', Reviews: 'review', Runbooks: 'runbook' };
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TICKETS_PER_DOC = 10;

export interface Doc {
  path: string; folder: DocFolder; title: string; status?: string; updated?: string;
  /** The day (`YYYY-MM-DD`) the file was last written on disk; the date of a note whose frontmatter carries none. */
  modified?: string;
  /** The project folder the note sits in. */
  project: string; kind: DocKind;
  /** The tickets the note names (`ticket`, `tickets` or `epic`), at most ten. */
  tickets: string[];
  /** `ticket: none`: the note is marked project-level, so it is never reported as unattributed. */
  projectLevel: boolean;
  /** The stream the note names in frontmatter (`stream: Alpha`), or `none` when it is deliberately off every stream tab. */
  stream?: string;
}
export interface Docs { docs: Doc[]; notes: string[] }

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
const DATE_KEYS = ['updated', 'last-updated', 'date', 'created'] as const;

/** Ticket ids from a frontmatter value: `id`, `[a, b]` or `"id"`. Anything that is not an id is dropped. */
function ticketIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[|\]$/g, '');
  return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter((x) => TICKET_ID.test(x)).slice(0, MAX_TICKETS_PER_DOC);
}

/** A document's header: title (frontmatter `title`, else its first `# ` heading, else the file name), status, the first date of `updated`, `last-updated`, `date`, `created`, the tickets it names and its kind. */
export function docHeader(head: string, fileName: string, folder: DocFolder = 'Plans'): { title: string; status?: string; updated?: string; kind: DocKind; tickets: string[]; projectLevel: boolean; stream?: string } {
  const fm = head.match(/^---\n([\s\S]*?)\n---\n?/);
  /** The value of a key; a key with no value on its line takes the `- item` lines right under it as a list. */
  const raw = (k: string): string | undefined => {
    const lines = fm?.[1]?.split('\n') ?? [];
    const at = lines.findIndex((l) => l.startsWith(`${k}:`));
    if (at === -1) return undefined;
    const inline = (lines[at] as string).slice(k.length + 1).trim();
    if (inline) return inline;
    const items: string[] = [];
    for (const l of lines.slice(at + 1)) { const m = l.match(/^\s*-\s+(.+)$/); if (!m) break; items.push(m[1] as string); }
    return items.length ? items.join(',') : undefined;
  };
  const get = (k: string): string | undefined => { const v = raw(k); return v ? clean(v.replace(/^"|"$/g, '')) || undefined : undefined; };
  const body = fm ? head.slice(fm[0].length) : head;
  const title = get('title') || clean(body.match(/^#\s+(.+)$/m)?.[1] ?? '') || fileName.replace(/\.md$/, '');
  const date = DATE_KEYS.map(get).find((d) => d !== undefined);
  const named = [...new Set([...ticketIds(raw('ticket')), ...ticketIds(raw('tickets')), ...ticketIds(raw('epic'))])].filter((t) => t.toLowerCase() !== 'none').slice(0, MAX_TICKETS_PER_DOC);
  const pick = (v: string | undefined): DocKind | undefined => DOC_KINDS.find((k) => k === v?.toLowerCase());
  return {
    title, ...(get('status') ? { status: get('status') } : {}), ...(date ? { updated: date } : {}),
    kind: pick(get('kind')) ?? pick(get('type')) ?? FOLDER_KIND[folder], tickets: named, ...(get('stream') ? { stream: get('stream') } : {}),
    projectLevel: !named.length && [raw('ticket'), raw('tickets')].some((v) => v?.trim().replace(/^["'\[]|["'\]]$/g, '').toLowerCase() === 'none'),
  };
}

/** The documents of one project. A folder or file the reader refuses is a note (vault-relative path and reason), not an error. */
export function loadDocs(reader: VaultReader, project: string): Docs {
  const docs: Doc[] = [];
  const notes: string[] = [];
  const add = (folder: DocFolder, path: string): void => {
    const r = reader.head(path, HEAD_BYTES, MAX_DOC_BYTES);
    if (!r.ok) { if (r.reason !== 'denied' && r.reason !== 'missing') notes.push(`${path}: ${r.reason}`); return; }
    docs.push({ path, folder, project, modified: new Date(r.mtimeMs).toISOString().slice(0, 10), ...docHeader(r.text, path.split('/').at(-1) as string, folder) });
  };
  for (const name of ['CONTEXT', 'DECISIONS'] as const) add(name, `Projects/${project}/${name}.md`);
  for (const folder of DOC_FOLDERS) {
    const dir = `Projects/${project}/${folder}`;
    const ls = reader.list(dir);
    if (!ls.ok) { if (ls.reason !== 'missing' && ls.reason !== 'denied') notes.push(`${dir}: ${ls.reason}`); continue; }
    const files = ls.files.map((f) => `${dir}/${f}`);
    for (const sub of ls.dirs.slice(0, MAX_SUBFOLDERS)) {
      const inner = reader.list(`${dir}/${sub}`);
      if (inner.ok) files.push(...inner.files.map((f) => `${dir}/${sub}/${f}`));
      else if (inner.reason !== 'missing' && inner.reason !== 'denied') notes.push(`${dir}/${sub}: ${inner.reason}`);
    }
    if (ls.dirs.length > MAX_SUBFOLDERS) notes.push(`${dir}: ${ls.dirs.length} subfolders; only the first ${MAX_SUBFOLDERS} are read`);
    if (files.length > MAX_DOCS_PER_PROJECT) notes.push(`${dir}: ${files.length} documents; only the first ${MAX_DOCS_PER_PROJECT} are read`);
    for (const path of files.slice(0, MAX_DOCS_PER_PROJECT)) add(folder, path);
  }
  return { docs, notes };
}
