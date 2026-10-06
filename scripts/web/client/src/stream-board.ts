import { BASE_CSS, h, refLink, shadow } from './dom.ts';
import './ask-card.ts';
import './md-fragment.ts';
import { prChips } from './pr-chips.ts';
import type { PodiumState, PrCard, WorkItem } from './types.ts';

const CSS = `${BASE_CSS}
  h2 { margin: 16px 0 8px; font-size: 1.1rem; }
  h2 .n { color: var(--text-secondary); font-weight: 400; }
  .cards { display: grid; gap: 12px; }
  ul.items { margin: 0; padding-left: 20px; }
  ul.items li { margin: 2px 0; }
  .gate { color: var(--text-secondary); }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: var(--surface-2); }
  .chip { display: inline-block; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; margin: 0 4px 2px 0; font-size: 12px; white-space: nowrap; }
  .chip.bad { color: var(--bad); border-color: var(--bad); }
  .chip.good { color: var(--good); border-color: var(--good); }
  .chip.warn { color: var(--warn); border-color: var(--warn); }
  .empty { color: var(--text-secondary); }
`;

/** <stream-board stream="...">: one stream's asks, work and PRs from `.state`. */
export class StreamBoard extends HTMLElement {
  static observedAttributes = ['stream'];
  #root: ShadowRoot;
  #state: PodiumState | null = null;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get state(): PodiumState | null { return this.#state; }
  set state(s: PodiumState | null) { this.#state = s; this.#render(); }
  attributeChangedCallback(): void { this.#render(); }

  #render(): void {
    const st = this.#state;
    const stream = this.getAttribute('stream') ?? '';
    if (!st) { this.#root.replaceChildren(); return; }
    const inStream = <T extends { stream: string }>(xs: T[]): T[] => xs.filter((x) => x.stream === stream);
    const asks = inStream(st.asks).map((a) => {
      const card = h('ask-card');
      card.ask = a;
      return card;
    });
    const frag = st.fragments?.[stream];
    const md = frag ? h('md-fragment') : null;
    if (md && frag) md.markdown = frag;
    this.#root.replaceChildren(
      section('Awaiting you', asks.length, asks.length ? h('div', { class: 'cards' }, ...asks) : null),
      section('Working', inStream(st.working).length, items(inStream(st.working))),
      section('Queued', inStream(st.queued).length, items(inStream(st.queued))),
      section('Blocked', inStream(st.blocked).length, items(inStream(st.blocked), (b) => ('gate' in b && b.gate ? ` (waiting on ${b.gate})` : ''))),
      section('Pull requests', inStream(st.prs).length, prTable(inStream(st.prs))),
      ...(md ? [h('section', {}, h('h2', {}, 'Notes'), md)] : []),
    );
  }
}

function section(title: string, n: number, body: Node | null): HTMLElement {
  return h('section', { 'aria-label': title }, h('h2', {}, title, ' ', h('span', { class: 'n' }, `(${n})`)),
    body ?? h('p', { class: 'empty' }, 'Nothing here.'));
}

function items<T extends WorkItem>(xs: T[], suffix: (x: T) => string = () => ''): Node | null {
  if (xs.length === 0) return null;
  return h('ul', { class: 'items' }, ...xs.map((x) => h('li', {}, h('code', {}, x.id), ' ', x.text, ...(x.ticket ? [' ', refLink(x.ticket)] : []), h('span', { class: 'gate' }, suffix(x)))));
}

function prTable(prs: PrCard[]): Node | null {
  if (prs.length === 0) return null;
  const rows = prs.map((p) => h('tr', {},
    h('td', {}, refLink({ label: `${p.short}#${p.number}`, url: p.url })),
    h('td', {}, p.title, p.twinOf ? ` (twin of #${p.twinOf})` : '', p.stackedOn ? ` (stacked on #${p.stackedOn})` : ''),
    h('td', {}, `${p.head} → ${p.base}`),
    h('td', {}, ...prChips(p).map((c) => h('span', { class: `chip ${c.tone}` }, c.text)))));
  return h('table', {}, h('caption', { class: 'vh' }, 'Pull requests'),
    h('thead', {}, h('tr', {}, ...['PR', 'Title', 'Branch', 'State'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, ...rows));
}

customElements.define('stream-board', StreamBoard);

declare global { interface HTMLElementTagNameMap { 'stream-board': StreamBoard } }
