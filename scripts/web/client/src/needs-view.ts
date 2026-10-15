/** The rows for the needs-you list that are not asks: a PR ready to merge, or a review waiting for an OK. Draws what needs-items works out. */
import { h, refLink, streamTag } from './dom.ts';
import { OTHERS_PRS, formatFragment } from './tabs.ts';
import type { NeedsItem } from './needs-items.ts';

const DAY = (n: number): string => (n === 0 ? 'today' : `${n} d`);

/** One row each: a kind badge (words, never colour alone), the PR as a link, its age, then stream, base, ticket, author and verdict. */
export function needsRows(items: NeedsItem[], showStream: boolean): HTMLElement | null {
  if (items.length === 0) return null;
  return h('ul', { class: 'rows needs-items', role: 'list', 'aria-label': 'Pull requests and reviews that wait on you' }, ...items.map((i) => {
    const ref = `${i.repo.split('/')[1] ?? i.repo}#${i.number}`;
    const sub = [
      showStream ? streamTag(i.stream) : null,
      i.base ? h('span', {}, h('span', { class: 'vh' }, 'base '), i.base) : null,
      i.ticket ? refLink(i.ticket) : null,
      i.author ? h('span', {}, `by ${i.author}`) : null,
      i.verdict ? h('span', {}, `proposed: ${i.verdict}`) : null,
      h('span', {}, i.summary),
      i.kind === 'approve review' ? h('a', { href: formatFragment(OTHERS_PRS), 'aria-label': `Open the draft of the review of ${ref}; opens the Others' PRs tab` }, 'Open the draft') : null,
    ].filter((n): n is HTMLElement => n !== null);
    return h('li', { 'data-kind': i.kind },
      h('span', { class: `chip ${i.kind === 'ready to merge' ? 'good' : 'warn'}` }, i.kind),
      h('span', { class: 'row-text' }, refLink({ label: i.kind === 'ready to merge' ? `${ref} ${i.title}` : `${i.title}`, url: i.url })),
      h('span', { class: 'row-meta' }, ...(i.ageDays !== undefined ? [h('span', { class: 'vh' }, 'waiting '), DAY(i.ageDays)] : [])),
      h('span', { class: 'row-sub' }, ...sub));
  }));
}
