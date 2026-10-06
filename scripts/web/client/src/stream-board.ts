import { BASE_CSS, UI_CSS, h, refLink, shadow, streamTag } from './dom.ts';
import './ask-card.ts';
import './md-fragment.ts';
import { fragmentFor } from './contract.ts';
import { prChips } from './pr-chips.ts';
import { ago, clockTime } from './glance.ts';
import type { AskCard, DoneItem, PodiumState, PrCard, WorkItem } from './types.ts';

const CSS = `${BASE_CSS}${UI_CSS}
  ul.prs { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
  ul.prs > li { display: grid; gap: var(--space-1); padding: var(--space-3) 0; border-bottom: 1px solid var(--border); }
  .pr-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-2); font-size: var(--text-md); line-height: var(--leading-md); }
  .pr-title a { font-family: var(--font-mono); font-size: var(--text-sm); white-space: nowrap; }
  .pr-branch { font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .pr-rel { color: var(--text-secondary); font-size: var(--text-sm); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
`;

/** The shared stylesheet text for anything that draws sections, rows and PR lists (the overview reuses it). */
export const BOARD_CSS = CSS;

export type Tone = 'accent' | 'critical' | 'success' | 'neutral';
export interface SectionSpec { title: string; n: number; glyph: string; tone: Tone; empty: string; quiet?: boolean }

let sectionSeq = 0;

/** A titled section with its count; an empty body becomes a one-line empty state that says what empty means. */
export function section(spec: SectionSpec, body: Node | null): HTMLElement {
  const id = `s${++sectionSeq}`;
  return h('section', { 'aria-labelledby': id, class: `tone-${spec.tone}${spec.quiet ? ' quiet' : ''}` },
    h('div', { class: 'head' },
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, spec.glyph),
      h('h2', { id }, spec.title, spec.n > 0 ? h('span', { class: 'count' }, h('span', { class: 'vh' }, ', '), String(spec.n)) : null)),
    body ?? h('p', { class: 'empty' }, spec.empty));
}

/** Where rows are drawn: the reference time and zone for ages, and whether each row names its stream. */
export interface RowContext { now: string; tz: string; showStream: boolean }

/** One row per item: id, text and ticket, a right-aligned age (or closing time), then stream, gate and model. */
export function itemRows<T extends WorkItem>(xs: T[], ctx: RowContext): HTMLElement | null {
  if (xs.length === 0) return null;
  return h('ul', { class: 'rows' }, ...xs.map((x) => {
    const done = 'closedAt' in x ? (x as unknown as DoneItem).closedAt : '';
    const meta = done ? clockTime(done, ctx.tz) : ago(x.since, ctx.now);
    const gate = 'gate' in x && typeof x.gate === 'string' && x.gate ? x.gate : '';
    const sub = [
      ctx.showStream ? streamTag(x.stream) : null,
      gate ? h('span', { class: 'gate' }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '⊘'), `Waiting on ${gate}`) : null,
      x.model ? h('span', {}, x.model) : null,
    ].filter((n): n is HTMLElement => n !== null);
    return h('li', {},
      h('span', { class: 'id' }, x.id),
      h('span', { class: 'row-text' }, x.text, ...(x.ticket ? [' ', refLink(x.ticket)] : [])),
      h('span', { class: 'row-meta' }, meta ? (done ? `shipped ${meta}` : meta) : ''),
      sub.length ? h('span', { class: 'row-sub' }, ...sub) : null);
  }));
}

/** Ask cards; `showStream` tags each card with its stream (the overview mixes streams). */
export function askCards(asks: AskCard[], live: boolean, showStream: boolean): HTMLElement | null {
  if (asks.length === 0) return null;
  return h('div', { class: 'cards' }, ...asks.map((a) => {
    const card = h('ask-card');
    card.showStream = showStream;
    card.locked = !live;
    card.ask = a;
    return card;
  }));
}

/** Open PRs as rows: link and title, branch, then status chips (text and symbol, never colour alone). */
export function prList(prs: PrCard[]): HTMLElement | null {
  if (prs.length === 0) return null;
  return h('ul', { class: 'prs', 'aria-label': 'Pull requests' }, ...prs.map((p) => h('li', {},
    h('span', { class: 'pr-title' }, refLink({ label: `${p.short}#${p.number}`, url: p.url }), h('span', {}, p.title)),
    h('span', { class: 'pr-branch' }, `${p.head} → ${p.base}`,
      p.twinOf ? h('span', { class: 'pr-rel' }, ` · twin of #${p.twinOf}`) : null,
      p.stackedOn ? h('span', { class: 'pr-rel' }, ` · stacked on #${p.stackedOn}`) : null),
    h('span', { class: 'chips' }, ...prChips(p).map((c) => h('span', { class: `chip ${c.tone}` }, c.text))))));
}

/** <stream-board stream="...">: one stream's asks, work and PRs from `.state`. */
export class StreamBoard extends HTMLElement {
  static observedAttributes = ['stream'];
  #root: ShadowRoot;
  #state: PodiumState | null = null;
  #live = false;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get state(): PodiumState | null { return this.#state; }
  set state(s: PodiumState | null) { this.#state = s; this.#render(); }
  /** True only when the state came from a server; sample data leaves every ask card locked. */
  get live(): boolean { return this.#live; }
  set live(v: boolean) { this.#live = v; this.#render(); }
  attributeChangedCallback(): void { this.#render(); }

  #render(): void {
    const st = this.#state;
    const stream = this.getAttribute('stream') ?? '';
    if (!st) { this.#root.replaceChildren(); return; }
    const inStream = <T extends { stream: string }>(xs: T[]): T[] => xs.filter((x) => x.stream === stream);
    const ctx: RowContext = { now: st.generatedAt, tz: st.tz, showStream: false };
    const asks = inStream(st.asks);
    const working = inStream(st.working);
    const queued = inStream(st.queued);
    const blocked = inStream(st.blocked);
    const done = inStream(st.done);
    const deferred = inStream(st.deferred);
    const prs = inStream(st.prs);
    const frag = fragmentFor(st.fragments, stream);
    const md = frag ? h('md-fragment') : null;
    if (md && frag) md.markdown = frag;
    this.#root.replaceChildren(h('div', { class: 'board' },
      h('div', { class: 'col' },
        section({ title: 'Needs you', n: asks.length, glyph: '●', tone: 'accent', empty: 'Nothing in this stream needs you right now.' }, askCards(asks, this.#live, false)),
        section({ title: 'Blocked', n: blocked.length, glyph: '⊘', tone: 'critical', empty: 'Nothing is blocked.' }, itemRows(blocked, ctx)),
        section({ title: 'Pull requests', n: prs.length, glyph: '⇄', tone: 'neutral', empty: 'No open pull requests in this stream.' }, prList(prs))),
      h('div', { class: 'col' },
        section({ title: 'In flight', n: working.length, glyph: '◐', tone: 'neutral', empty: 'Nothing in flight.', quiet: true }, itemRows(working, ctx)),
        section({ title: 'Queued', n: queued.length, glyph: '○', tone: 'neutral', empty: 'The queue is empty.', quiet: true }, itemRows(queued, ctx)),
        section({ title: 'Shipped today', n: done.length, glyph: '✓', tone: 'success', empty: 'Nothing shipped yet today.', quiet: true }, itemRows(done, ctx)),
        deferred.length ? section({ title: 'Deferred', n: deferred.length, glyph: '↷', tone: 'neutral', empty: '', quiet: true }, itemRows(deferred, ctx)) : null,
        md ? section({ title: 'Notes', n: 0, glyph: '¶', tone: 'neutral', empty: '', quiet: true }, md) : null)));
  }
}

customElements.define('stream-board', StreamBoard);

declare global { interface HTMLElementTagNameMap { 'stream-board': StreamBoard } }
