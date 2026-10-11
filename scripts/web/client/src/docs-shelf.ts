/** An epic's documents as links grouped by kind, newest first within a group. The server built every url; the client re-checks it before it becomes an href. */
import { h, refLink } from './dom.ts';
import type { EpicDocs } from './types.ts';

export const SHELF_CSS = `
  .shelf { margin-top: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .shelf h4 { margin: var(--space-2) 0 0; font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--text-secondary); letter-spacing: 0.04em; text-transform: uppercase; }
  .shelf ul { list-style: none; margin: 0; padding: 0; }
  .shelf li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); padding: var(--space-1) 0; min-block-size: 24px; overflow-wrap: anywhere; }
  .shelf .meta { color: var(--text-muted); }
`;

const KIND_TITLE: Record<string, string> = { brief: 'Briefs', plan: 'Plans', uat: 'UAT', runbook: 'Runbooks', review: 'Reviews', research: 'Research', decision: 'Decisions', other: 'Other' };

/** The title of a kind group, with a sensible fallback for a kind this client does not know. */
export const kindTitle = (kind: string): string => KIND_TITLE[kind] ?? 'Other';

/** The documents of one epic, or null when it has none. `unattributedRecent` is said once, as a fact the author can fix. */
export function docsShelf(docs: EpicDocs): HTMLElement | null {
  const groups = docs.groups.filter((g) => g.items.length > 0);
  if (!groups.length && docs.unattributedRecent === 0) return null;
  return h('div', { class: 'shelf' },
    ...groups.flatMap((g) => [
      h('h4', {}, kindTitle(g.kind)),
      h('ul', { role: 'list' }, ...g.items.map((d) => h('li', {}, refLink({ label: d.title, url: d.url }), h('span', { class: 'meta' }, [d.status, d.updated].filter(Boolean).join(' · '))))),
      g.more ? h('p', { class: 'meta' }, `${g.more} more`) : null,
    ]),
    docs.unattributedRecent ? h('p', { class: 'meta' }, `${docs.unattributedRecent} recent ${docs.unattributedRecent === 1 ? 'note names' : 'notes name'} no ticket, so no epic shows ${docs.unattributedRecent === 1 ? 'it' : 'them'}. Attach with ticket.mjs attach.`) : null);
}
