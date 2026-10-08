/**
 * The link rail: pinned links, epics, documents, pull requests and runbooks, in that order. Every URL is built here from
 * validated parts (a note becomes an `obsidian://open` link with only `vault` and `file`; a pin must be http or https), so
 * the client never makes a link out of text. Each group holds at most 50 links, with `more` counting the rest.
 */
import { obsidianUri } from '../status-page/links.ts';
import { prFlagNames } from '../status-page/render.ts';
import type { PageConfig, Pr } from '../status-page/render.ts';
import { isHttpUrl } from './config.ts';
import type { StreamHomeConfig } from './config.ts';
import type { Doc } from './docs.ts';
import type { EpicSummary, LinkGroup, RailLink, Unknown } from './types.ts';

const GROUP_CAP = 50;
const noteUrl = (page: PageConfig, path: string): string | null => (page.vaultName ? obsidianUri(page.vaultName, path.replace(/\.md$/, '')) : null);
const baseName = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.md$/, '');

export interface RailInput {
  page: PageConfig; cfg: StreamHomeConfig | undefined; stream: string; epics: EpicSummary[]; prs: Pr[];
  /** Documents of each mapped project, by project name. */
  docs: Map<string, Doc[]>;
}

/** Plans that are active or in review first, then newest `updated`, then path. */
const planRank = (d: Doc): number => (d.status === 'active' || d.status === 'in-review' ? 0 : 1);
const newestFirst = (a: Doc, b: Doc): number => (b.updated ?? '').localeCompare(a.updated ?? '') || a.path.localeCompare(b.path);
const planOrder = (a: Doc, b: Doc): number => planRank(a) - planRank(b) || newestFirst(a, b);

function docLink(page: PageConfig, d: Doc): RailLink | null {
  const url = noteUrl(page, d.path);
  return url ? { label: d.title, kind: 'note', url, meta: [d.folder, d.status].filter(Boolean).join(' · ') } : null;
}

export function buildRail(inp: RailInput, unknowns: Unknown[]): LinkGroup[] {
  const { page, cfg } = inp;
  const noNotes = !page.vaultName;
  const pinned: (RailLink | null)[] = (cfg?.pins ?? []).map((p) => {
    if ('url' in p) return isHttpUrl(p.url) ? { label: p.label, kind: 'web', url: p.url } : null;
    const url = noteUrl(page, p.note);
    return url ? { label: p.label, kind: 'note', url } : null;
  });
  if (noNotes && (cfg?.pins ?? []).some((p) => 'note' in p)) unknowns.push({ kind: 'config-invalid', text: 'Note pins and docs need the vault name (obsidian_vault) to become links; they are left out.' });

  const epics: (RailLink | null)[] = inp.epics.flatMap((e) => [
    e.note.url ? { label: e.id, kind: 'note' as const, url: e.note.url, meta: e.title } : null,
    e.tracker?.url ? { label: e.tracker.label, kind: 'tracker' as const, url: e.tracker.url, meta: e.id } : null,
  ]);

  const docsOf = (folder: Doc['folder'][], order: (a: Doc, b: Doc) => number): Doc[] => [...inp.docs.values()].flatMap((ds) => ds.filter((d) => folder.includes(d.folder)).sort(order));
  const pinnedDocs = (cfg?.docs ?? []).map((path): RailLink | null => { const url = noteUrl(page, path); return url ? { label: baseName(path), kind: 'note', url, meta: 'pinned doc' } : null; });
  for (const [project, ds] of inp.docs) if (!ds.some((d) => d.folder === 'CONTEXT' || d.folder === 'DECISIONS')) unknowns.push({ kind: 'missing-context', text: `Projects/${project} has no CONTEXT.md or DECISIONS.md.` });
  const docs = [...pinnedDocs, ...docsOf(['CONTEXT'], newestFirst).map((d) => docLink(page, d)), ...docsOf(['DECISIONS'], newestFirst).map((d) => docLink(page, d)),
    ...docsOf(['Plans'], planOrder).map((d) => docLink(page, d)), ...docsOf(['Research', 'Reviews', 'Knowledge'], newestFirst).map((d) => docLink(page, d))];

  const prs = inp.prs.filter((p) => p.stream === inp.stream && isHttpUrl(p.url)).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)
    .map((p): RailLink => ({ label: `${p.short}#${p.number}`, kind: 'pr', url: p.url, meta: [p.isDraft ? 'draft' : 'ready', ...prFlagNames(p)].join(' · ') }));

  const runbooks = [...(cfg?.runbooks ?? []).map((path): RailLink | null => { const url = noteUrl(page, path); return url ? { label: baseName(path), kind: 'note', url, meta: 'pinned runbook' } : null; }),
    ...docsOf(['Runbooks'], newestFirst).map((d) => docLink(page, d))];

  const groups: [LinkGroup['group'], (RailLink | null)[]][] = [['pinned', pinned], ['epics', epics], ['docs', docs], ['prs', prs], ['runbooks', runbooks]];
  return groups.flatMap(([group, items]) => {
    const seen = new Set<string>();
    const unique = items.filter((l): l is RailLink => l !== null && !seen.has(l.url) && !!seen.add(l.url));
    return unique.length ? [{ group, items: unique.slice(0, GROUP_CAP), more: Math.max(0, unique.length - GROUP_CAP) }] : [];
  });
}
