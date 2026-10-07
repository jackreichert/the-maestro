/**
 * The documents that belong to one epic. Attribution lives on the document: a note names the ticket it serves in its
 * frontmatter (`ticket`, `tickets` or `epic`), and the epic is whichever epic's tree holds that ticket, so a plan written for a
 * child ticket lands on the epic with nobody naming the epic. Links to documents outside the vault come from the epic ticket's
 * own `## Links` section, and only `http` and `https` ones are kept. Every URL is built here; the client makes none.
 */
import { obsidianUri } from '../status-page/links.ts';
import { isHttpUrl } from './config.ts';
import type { Doc, DocKind } from './docs.ts';
import type { DocItem, EpicDocs } from './types.ts';

const GROUP_CAP = 20;
const RECENT_DAYS = 30;
const DAY_MS = 86_400_000;
const LABEL_MAX = 120;
/** Brief first, then the order a reader wants them in. */
const KIND_ORDER: readonly DocKind[] = ['brief', 'plan', 'uat', 'runbook', 'review', 'research', 'decision', 'other'];

const clip = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
const newestFirst = (a: DocItem, b: DocItem): number => (b.updated ?? '').localeCompare(a.updated ?? '') || a.title.localeCompare(b.title);

/** `- [label](https://...) · kind` lines of a ticket's `## Links` section. A line that is not that, or whose URL is not http(s), is skipped. */
export function externalLinks(body: string): { label: string; url: string; kind: DocKind }[] {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => /^## Links\s*$/i.test(l));
  if (at === -1) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).flatMap((l) => {
    const m = l.match(/^\s*[-*]\s*\[([^\]]+)\]\((\S+?)\)(?:\s*[·|]\s*([a-z]+))?\s*$/);
    if (!m || !isHttpUrl(m[2])) return [];
    const kind = KIND_ORDER.find((k) => k === m[3]) ?? 'other';
    return [{ label: clip(m[1] as string), url: m[2] as string, kind }];
  });
}

export interface EpicDocsInput {
  epic: string;
  /** Ids in the epic's tree, the epic included. */
  tree: ReadonlySet<string>;
  /** The epic ticket's body, for its `## Links` section. */
  epicBody: string;
  /** Every document read for the projects of the epic's tree. */
  docs: readonly Doc[];
  vaultName: string;
  now: Date;
}

/** The documents attributed to one epic, grouped by kind, with their paths (so the caller can take them off the rail) and dates (for brief freshness). */
export function epicDocs(inp: EpicDocsInput): { docs: EpicDocs; paths: Set<string>; dates: (string | undefined)[] } {
  const mine = inp.docs.filter((d) => d.tickets.some((t) => inp.tree.has(t)));
  const projects = new Set(inp.docs.map((d) => d.project));
  const items: DocItem[] = mine.map((d) => ({
    title: d.title, kind: d.kind, project: d.project, ticket: d.tickets.find((t) => inp.tree.has(t)) as string,
    ...(d.status ? { status: d.status } : {}), ...(d.updated ? { updated: d.updated } : {}),
    ...(inp.vaultName ? { url: obsidianUri(inp.vaultName, d.path.replace(/\.md$/, '')) } : {}),
  }));
  for (const l of externalLinks(inp.epicBody)) items.push({ title: l.label, kind: l.kind, project: '', ticket: inp.epic, url: l.url });
  const cutoff = inp.now.getTime() - RECENT_DAYS * DAY_MS;
  const unattributedRecent = inp.docs.filter((d) => projects.has(d.project) && d.folder !== 'CONTEXT' && d.folder !== 'DECISIONS' && !d.tickets.length && !d.projectLevel
    && /^\d{4}-\d{2}-\d{2}/.test(d.updated ?? '') && Date.parse(`${(d.updated as string).slice(0, 10)}T00:00:00Z`) >= cutoff).length;
  const groups = KIND_ORDER.flatMap((kind) => {
    const of = items.filter((i) => i.kind === kind).sort(newestFirst);
    return of.length ? [{ kind, items: of.slice(0, GROUP_CAP), more: Math.max(0, of.length - GROUP_CAP) }] : [];
  });
  return { docs: { groups, unattributedRecent }, paths: new Set(mine.map((d) => d.path)), dates: mine.map((d) => d.updated) };
}
