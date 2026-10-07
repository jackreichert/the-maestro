/**
 * Project documents for the link rail: `CONTEXT.md`, `DECISIONS.md` and the `*.md` files directly inside Plans, Research,
 * Reviews and Runbooks. Only the first 4 KB of each is read (frontmatter and first heading), through the guarded reader.
 */
import type { Scope, VaultReader } from '../vault/reader.ts';

export const DOC_FOLDERS = ['Plans', 'Research', 'Reviews', 'Runbooks'] as const;
export type DocFolder = 'CONTEXT' | 'DECISIONS' | (typeof DOC_FOLDERS)[number];
export const DOC_DIR_SCOPES: readonly Scope[] = [{ name: 'doc folder', pattern: /^Projects\/[^/]+\/(Plans|Research|Reviews|Runbooks)$/ }];
export const DOC_FILE_SCOPES: readonly Scope[] = [
  { name: 'project doc', pattern: /^Projects\/[^/]+\/(CONTEXT|DECISIONS)\.md$/ },
  { name: 'folder doc', pattern: /^Projects\/[^/]+\/(Plans|Research|Reviews|Runbooks)\/[^/]+\.md$/ },
];

const HEAD_BYTES = 4096;
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_DOCS_PER_PROJECT = 500;
const TITLE_MAX = 120;

export interface Doc { path: string; folder: DocFolder; title: string; status?: string; updated?: string }
export interface Docs { docs: Doc[]; notes: string[] }

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

/** A document's title (frontmatter `title`, else its first `# ` heading, else the file name), status and updated date. */
export function docHeader(head: string, fileName: string): { title: string; status?: string; updated?: string } {
  const fm = head.match(/^---\n([\s\S]*?)\n---\n?/);
  const get = (k: string): string | undefined => { const m = fm?.[1]?.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return m?.[1] ? clean(m[1].replace(/^"|"$/g, '')) : undefined; };
  const body = fm ? head.slice(fm[0].length) : head;
  const title = get('title') || clean(body.match(/^#\s+(.+)$/m)?.[1] ?? '') || fileName.replace(/\.md$/, '');
  return { title, ...(get('status') ? { status: get('status') } : {}), ...(get('updated') ? { updated: get('updated') } : {}) };
}

/** The documents of one project. A folder or file the reader refuses is a note (vault-relative path and reason), not an error. */
export function loadDocs(reader: VaultReader, project: string): Docs {
  const docs: Doc[] = [];
  const notes: string[] = [];
  const add = (folder: DocFolder, path: string): void => {
    const r = reader.head(path, HEAD_BYTES, MAX_DOC_BYTES);
    if (!r.ok) { if (r.reason !== 'denied' && r.reason !== 'missing') notes.push(`${path}: ${r.reason}`); return; }
    docs.push({ path, folder, ...docHeader(r.text, path.split('/').at(-1) as string) });
  };
  for (const name of ['CONTEXT', 'DECISIONS'] as const) add(name, `Projects/${project}/${name}.md`);
  for (const folder of DOC_FOLDERS) {
    const dir = `Projects/${project}/${folder}`;
    const ls = reader.list(dir);
    if (!ls.ok) { if (ls.reason !== 'missing' && ls.reason !== 'denied') notes.push(`${dir}: ${ls.reason}`); continue; }
    if (ls.files.length > MAX_DOCS_PER_PROJECT) notes.push(`${dir}: ${ls.files.length} documents; only the first ${MAX_DOCS_PER_PROJECT} are read`);
    for (const f of ls.files.slice(0, MAX_DOCS_PER_PROJECT)) add(folder, `${dir}/${f}`);
  }
  return { docs, notes };
}
