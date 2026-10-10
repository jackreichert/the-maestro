/** The library as data: every page under the vault's Knowledge and Runbooks folders reduced to the facets the index and INDEX.md need, and the links between pages. Reads the vault; writes nothing. */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discover } from '../../library-check.ts';
import { bodyLinks, linkTarget, list, parsePage, text } from './page.ts';

/** Frontmatter keys whose values name other pages. */
export const LINK_FIELDS = ['depends-on', 'supersedes', 'superseded-by'] as const;

export interface LibraryPage {
  /** Vault-relative path. */
  path: string;
  repo: string;
  kind: string;
  title: string;
  /** The sentence after `Read when:`, or ''. */
  readWhen: string;
  components: string[];
  stream: string;
  status: string;
  /** `YYYY-MM-DD`, or '' when absent; any `@sha` suffix is dropped. */
  verifiedAt: string;
  /** The page below its frontmatter. */
  body: string;
  /** Link targets as written (anchor, alias and `.md` removed) and where each came from: `body` or a frontmatter key. */
  links: { target: string; via: string }[];
}

export interface LinkRow { src: string; target: string; via: string; /** The library page it resolves to, or null (a note outside the library, or nothing). */ targetPath: string | null }

/** Reads every library page of the vault (`repo` limits it to one project). A file that cannot be read is skipped. */
export function readLibrary(vault: string, repo?: string): LibraryPage[] {
  const pages: LibraryPage[] = [];
  for (const rel of discover(vault, repo).sort()) {
    let raw: string;
    try { raw = readFileSync(join(vault, rel), 'utf8'); } catch { continue; }
    const p = parsePage(rel, raw);
    const body = p.lines.slice(p.bodyStart).join('\n');
    pages.push({
      path: rel,
      repo: text(p, 'repo') || rel.split('/')[1] || '',
      kind: text(p, 'kind'),
      title: (body.match(/^#\s+(.+?)\s*$/m)?.[1]) ?? basename(rel, '.md'),
      readWhen: (body.match(/^Read when:\s*(\S.*?)\s*$/m)?.[1]) ?? '',
      components: list(p, 'components'),
      stream: text(p, 'stream'),
      status: text(p, 'status'),
      verifiedAt: text(p, 'verified-at').split('@')[0]?.trim() ?? '',
      body,
      links: [
        ...LINK_FIELDS.flatMap((k) => list(p, k).map((t) => ({ target: linkTarget(t), via: k }))),
        ...bodyLinks(p).map((l) => ({ target: l.target, via: 'body' })),
      ].filter((l) => l.target),
    });
  }
  return pages;
}

/** One row per link, resolved to a library page by vault path or, failing that, by base name (the first page in path order when two share one). */
export function linkRows(pages: LibraryPage[]): LinkRow[] {
  const byRef = new Map<string, string>();
  for (const p of [...pages].reverse()) { byRef.set(p.path.replace(/\.md$/, ''), p.path); byRef.set(basename(p.path, '.md'), p.path); }
  for (const p of pages) byRef.set(p.path.replace(/\.md$/, ''), p.path);
  return pages.flatMap((p) => p.links.map((l) => ({ src: p.path, target: l.target, via: l.via, targetPath: byRef.get(l.target) ?? null })));
}
