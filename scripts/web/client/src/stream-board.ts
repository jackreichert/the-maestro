import { BASE_CSS, UI_CSS, h, refLink, shadow, streamTag } from './dom.ts';
import './ask-card.ts';
import './md-fragment.ts';
import { fragmentFor } from './contract.ts';
import { prChips } from './pr-chips.ts';
import { ago, clockTime, oldestFirst } from './glance.ts';
import { gateView } from './gate.ts';
import type { GateView } from './gate.ts';
import type { AskCard, DoneItem, PodiumState, PrCard, WorkItem } from './types.ts';

const CSS = `${BASE_CSS}${UI_CSS}
  ul.prs { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
  ul.prs > li { display: grid; gap: var(--space-1); padding: var(--space-3) 0; border-bottom: 1px solid var(--border); }
  .pr-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-2); font-size: var(--text-md); line-height: var(--leading-md); }
  .pr-title a { font-family: var(--font-mono); font-size: var(--text-sm); white-space: nowrap; padding-block: 2px; margin-block: -2px; }
  .pr-branch { font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .pr-rel { color: var(--text-secondary); font-size: var(--text-sm); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
`;

/** The shared stylesheet text for anything that draws sections, rows and PR lists (the overview reuses it). */
export const BOARD_CSS = CSS;

export type Tone = 'accent' | 'critical' | 'success' | 'neutral';
/** A section; only the three status sections (needs you, blocked, shipped) carry a glyph. */
export interface SectionSpec { title: string; n: number; glyph?: string; tone: Tone; empty: string; rest?: Rest; quiet?: boolean; hint?: Node | null; action?: Node | null }

/** A musical word after an empty state's literal sentence; `lang` only when it is not English. */
export interface Rest { word: string; lang?: 'it' | 'la' }

/** The rest marks for the empty sections, after the literal sentence (never on errors). */
export const RESTS = {
  asks: { word: 'tacet', lang: 'la' },
  blocked: { word: 'a tempo', lang: 'it' },
  shipped: { word: 'before the downbeat' },
  working: { word: 'rest' },
  queued: { word: 'rest' },
} satisfies Record<string, Rest>;

let sectionSeq = 0;

/** A titled section with its count; an empty body becomes a one-line empty state that says what empty means. */
export function section(spec: SectionSpec, body: Node | null): HTMLElement {
  const id = `s${++sectionSeq}`;
  // An empty section's status glyph goes muted: a red blocked mark over "Nothing is blocked" would read as an alarm.
  const tone = body ? spec.tone : 'neutral';
  return h('section', { 'aria-labelledby': id, class: `tone-${tone}${spec.quiet ? ' quiet' : ''}` },
    h('div', { class: 'head' },
      spec.glyph ? h('span', { class: 'glyph', 'aria-hidden': 'true' }, spec.glyph) : null,
      h('h2', { id }, spec.title, spec.n > 0 ? h('span', { class: 'count' }, h('span', { class: 'vh' }, ', '), String(spec.n)) : null),
      body ? spec.action : null),
    body && spec.hint ? h('p', { class: 'section-hint' }, spec.hint) : null,
    body ?? h('p', { class: 'empty' }, spec.empty, spec.rest ? ' ' : null, spec.rest ? h('i', { class: 'rest', lang: spec.rest.lang }, spec.rest.word) : null));
}

/** Where rows are drawn: the reference time and zone for ages, and whether each row names its stream. */
export interface RowContext { now: string; tz: string; showStream: boolean; prs?: PrCard[] }

/** A blocked row's gate: the words, then its target, linked when the gate names a pull request with a known URL. */
function gateNode(g: GateView): HTMLElement {
  const target = g.url ? refLink({ label: g.label, url: g.url }) : h('span', { class: g.mono ? 'mono' : undefined }, g.label);
  if (g.url && target instanceof HTMLElement) target.classList.add('mono');
  return h('span', { class: 'gate' }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '⊘'), `${g.lead} `, target);
}

/** One row per item: id, text and ticket, a right-aligned age (or closing time), then stream, gate and model. */
export function itemRows<T extends WorkItem>(xs: T[], ctx: RowContext): HTMLElement | null {
  if (xs.length === 0) return null;
  return h('ul', { class: 'rows', role: 'list' }, ...xs.map((x) => {
    const done = 'closedAt' in x ? (x as unknown as DoneItem).closedAt : '';
    const meta = done ? clockTime(done, ctx.tz) : ago(x.since, ctx.now);
    const gate = 'gate' in x && typeof x.gate === 'string' && x.gate ? x.gate : '';
    const sub = [
      ctx.showStream ? streamTag(x.stream) : null,
      gate ? gateNode(gateView(gate, ctx.prs ?? [])) : null,
      x.model ? h('span', {}, x.model) : null,
    ].filter((n): n is HTMLElement => n !== null);
    return h('li', {},
      h('span', { class: 'id' }, x.id),
      h('span', { class: 'row-text' }, x.text, ...(x.ticket ? [' ', refLink(x.ticket)] : [])),
      // Under a "Shipped today" heading the word is redundant to the eye, so only a screen reader hears it.
      h('span', { class: 'row-meta' }, meta && done ? h('span', { class: 'vh' }, 'shipped ') : null, meta),
      sub.length ? h('span', { class: 'row-sub' }, ...sub) : null);
  }));
}

/**
 * Asks as one row each, oldest first; `showStream` tags each row with its stream (the overview mixes streams). With a
 * `cap`, only the oldest `cap` rows show until "Show all N" reveals the rest, so the sections below stay in view.
 */
export function askCards(asks: AskCard[], live: boolean, showStream: boolean, cap = Number.POSITIVE_INFINITY): AskList | null {
  if (asks.length === 0) return null;
  const id = `asks${++sectionSeq}`;
  const cards = oldestFirst(asks).map((a, i) => {
    const card = h('ask-card', { role: 'listitem', hidden: i >= cap });
    card.showStream = showStream;
    card.locked = !live;
    card.ask = a;
    return card;
  });
  const list = h('div', { class: 'asks', role: 'list', id }, ...cards);
  const hidden = cards.slice(cap);
  if (hidden.length === 0) return { list, more: null };
  // One name in both states (APG disclosure): aria-expanded carries the state, and the chevron turns to show it.
  const more = h('button', { type: 'button', class: 'more', 'aria-expanded': 'false', 'aria-controls': id },
    `Show all ${asks.length}`, h('span', { class: 'vh' }, ' asks'), h('span', { class: 'chev', 'aria-hidden': 'true' }));
  const label = (open: boolean): void => { more.setAttribute('aria-expanded', String(open)); };
  let open = false;
  more.addEventListener('click', () => {
    open = !open;
    for (const c of hidden) c.hidden = !open;
    label(open);
    // Revealing moves focus to the first ask that was hidden, so a keyboard user lands on the new rows, not past them.
    if (open) hidden[0]?.focusToggle();
  });
  return { list, more };
}

/** The asks list, and the Show all control when the list is capped (it sits at the right of the section heading). */
export interface AskList { list: HTMLElement; more: HTMLElement | null }

/** True on Apple platforms, where the copy shortcut is shown with the Command key. */
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** What the asks list says once, under its heading, instead of on every ask: how answering works on this page. */
export function askHint(live: boolean): Node {
  if (!live) return document.createTextNode('Sample data: asks open read-only. Answering needs the Podium server.');
  const hint = document.createDocumentFragment();
  // A phone has no shortcut to mention, and the shorter line keeps the hint to one line there.
  hint.append(h('span', { class: 'keys' }, h('kbd', {}, APPLE ? '⌘ Enter' : 'Ctrl Enter'), ' copies an answer for the chat; nothing is saved here yet.'),
    h('span', { class: 'touch' }, 'Answers are copied for the chat; nothing is saved here yet.'));
  return hint;
}

/** Open PRs as rows: link and title, branch, then status chips (text and symbol, never colour alone). */
export function prList(prs: PrCard[]): HTMLElement | null {
  if (prs.length === 0) return null;
  return h('ul', { class: 'prs', role: 'list', 'aria-label': 'Pull requests' }, ...prs.map((p) => h('li', {},
    h('span', { class: 'pr-title' }, refLink({ label: `${p.short}#${p.number}`, url: p.url }), h('span', {}, p.title)),
    h('span', { class: 'pr-branch' }, `${p.head} → ${p.base}`,
      p.twinOf ? h('span', { class: 'pr-rel' }, ` · twin of #${p.twinOf}`) : null,
      p.stackedOn ? h('span', { class: 'pr-rel' }, ` · stacked on #${p.stackedOn}`) : null),
    h('span', { class: 'chips' }, ...prChips(p).map(chip)))));
}

/** A status chip; its leading symbol is decoration for sighted readers (the words carry the state), so it is hidden. */
function chip(c: { text: string; tone: string }): HTMLElement {
  const m = /^([✓✗•]) (.*)$/.exec(c.text);
  return h('span', { class: `chip ${c.tone}` }, ...(m ? [h('span', { 'aria-hidden': 'true' }, m[1]), m[2]] : [c.text]));
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
    const ctx: RowContext = { now: st.generatedAt, tz: st.tz, showStream: false, prs: st.prs };
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
        section({ title: 'Needs you', n: asks.length, glyph: '●', tone: 'accent', empty: 'Nothing in this stream needs you right now.', rest: RESTS.asks, hint: askHint(this.#live) }, askCards(asks, this.#live, false)?.list ?? null),
        section({ title: 'Blocked', n: blocked.length, glyph: '⊘', tone: 'critical', empty: 'Nothing is blocked.', rest: RESTS.blocked }, itemRows(blocked, ctx)),
        section({ title: 'Pull requests', n: prs.length, tone: 'neutral', empty: 'No open pull requests in this stream.' }, prList(prs))),
      h('div', { class: 'col' },
        section({ title: 'In flight', n: working.length, tone: 'neutral', empty: 'Nothing in flight.', rest: RESTS.working, quiet: true }, itemRows(working, ctx)),
        section({ title: 'Queued', n: queued.length, tone: 'neutral', empty: 'The queue is empty.', rest: RESTS.queued, quiet: true }, itemRows(queued, ctx)),
        section({ title: 'Shipped today', n: done.length, glyph: '✓', tone: 'success', empty: 'Nothing shipped yet today.', rest: RESTS.shipped, quiet: true }, itemRows(done, ctx)),
        deferred.length ? section({ title: 'Deferred', n: deferred.length, tone: 'neutral', empty: '', quiet: true }, itemRows(deferred, ctx)) : null,
        md ? section({ title: 'Notes', n: 0, tone: 'neutral', empty: '', quiet: true }, md) : null)));
  }
}

customElements.define('stream-board', StreamBoard);

declare global { interface HTMLElementTagNameMap { 'stream-board': StreamBoard } }
