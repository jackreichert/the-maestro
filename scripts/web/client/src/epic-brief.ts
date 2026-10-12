/** An epic's brief, drawn from the typed block tree the server parsed: elements and text only, never markup, and a link only through the link policy. */
import { h, refLink } from './dom.ts';
import type { Block, EpicBrief, Inline } from './types.ts';

export const BRIEF_CSS = `
  .brief { display: grid; gap: var(--space-1); margin-top: var(--space-2); max-width: 70ch; font-size: var(--text-sm); line-height: var(--leading-sm); }
  .brief h4, .brief h5 { margin: var(--space-2) 0 0; font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  .brief p, .brief ul, .brief ol, .brief blockquote { margin: 0; }
  .brief ul, .brief ol { padding-inline-start: 1.4em; }
  .brief blockquote { padding-inline-start: var(--space-3); border-inline-start: 2px solid var(--border-strong); color: var(--text-secondary); }
  .brief-badge { color: var(--warning); font-weight: var(--weight-semibold); }
  .brief-why { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .brief-missing code { user-select: all; }
`;

function runs(rs: Inline[]): Node[] {
  return rs.map((r): Node => {
    if (r.link) return refLink({ label: r.text, url: r.link.url });
    if (r.code) return h('code', {}, r.text);
    if (r.strong) return h('strong', {}, r.text);
    if (r.em) return h('em', {}, r.text);
    return document.createTextNode(r.text);
  });
}

function block(b: Block): HTMLElement {
  switch (b.type) {
    case 'heading': return h(b.level === 3 ? 'h4' : 'h5', {}, ...runs(b.runs));
    case 'paragraph': return h('p', {}, ...runs(b.runs));
    case 'quote': return h('blockquote', {}, ...runs(b.runs));
    case 'list': return h(b.ordered ? 'ol' : 'ul', {}, ...b.items.map((i) => h('li', {}, ...runs(i.runs), i.children.length ? h('ul', {}, ...i.children.map((c) => h('li', {}, ...runs(c.runs)))) : null)));
  }
}

/** The words of a brief's freshness, or null when it is fresh. A badge has text and a glyph, so colour is never the only signal. */
export function briefBadge(brief: EpicBrief): string | null {
  switch (brief.state) {
    case 'fresh': return null;
    case 'stale': return 'Stale brief';
    case 'missing': return 'No brief';
    case 'too-long': return 'Brief too long';
    case 'unreadable': return 'Brief unreadable';
  }
}

/** The badge for the epic's meta line: a glyph and words, so colour is never the only signal. Null when the brief is fresh. */
export function briefBadgeEl(brief: EpicBrief): HTMLElement | null {
  const text = briefBadge(brief);
  return text ? h('span', { class: 'brief-badge' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), text) : null;
}

/** What the brief fold holds: when it was last written and why it is stale, the command that makes a missing one, then the brief itself. Null when there is none of that. */
export function briefView(epic: string, brief: EpicBrief): HTMLElement | null {
  const why = brief.state === 'stale' ? [brief.updated ? `Last written ${brief.updated}.` : '', brief.staleBecause?.join('; ') ?? ''].filter(Boolean).join(' ') : '';
  const missing = brief.state === 'missing';
  if (!why && !missing && !brief.blocks?.length) return null;
  return h('div', { class: 'brief' },
    why ? h('p', { class: 'brief-why' }, why) : null,
    missing ? h('p', { class: 'brief-why brief-missing' }, 'Write one with ', h('code', {}, `ticket.mjs brief ${epic} --refresh`), '.') : null,
    ...(brief.blocks ?? []).map(block));
}
