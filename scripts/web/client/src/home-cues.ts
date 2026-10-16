/** Woodwinds: the cues. The asks that wait on you, each marked with a rehearsal letter, filterable by stream and sortable; the real ask cards answer in place. */
import { h } from './dom.ts';
import './ask-card.ts';
import { todaysPriorities } from './glance.ts';
import { flyNote } from './home-ambience.ts';
import { conceptSection, streamVar, tacet } from './home-concept.ts';
import { orderNeedsYou } from './home-model.ts';
import type { AskOrder } from './home-model.ts';
import { homeUi } from './home-sections.ts';
import { scopedItems } from './needs-items.ts';
import type { NeedsItem } from './needs-items.ts';
import { needsRows } from './needs-view.ts';
import { PAGES, pagedRows } from './pager.ts';
import type { PodiumState } from './types.ts';

const CUE_KEY = 'home-cues';
/** Cues on one page of the Cues list. */
export const CUE_PAGE = 6;

export const CUES_CSS = `
  .chips-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 2px 0; list-style: none; }
  .fchip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-pill); background: transparent; cursor: pointer; font: inherit; font-size: var(--text-sm); color: var(--text-secondary); transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out); }
  .fchip .sw, .fchip i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .fchip .sw { background: var(--stream-color); }
  .fchip .c { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .fchip[aria-pressed=true] { background: var(--text-primary); border-color: var(--text-primary); color: var(--surface-1); }
  .fchip[aria-pressed=true] .c { color: inherit; }
  /* A selected stream chip takes its stream's colour as a tint; the text stays at full ink for contrast. */
  .fchip[aria-pressed=true].tinted { background: color-mix(in srgb, var(--stream-color) 16%, transparent); border-color: var(--stream-color); color: var(--text-primary); }
  .fchip[aria-pressed=true].tinted .c { color: var(--text-secondary); }
  @media (hover: hover) { .fchip:hover:not([aria-pressed=true]) { border-color: var(--border-strong); color: var(--text-primary); } }
  .select-field { display: inline-flex; align-items: center; gap: var(--space-2); margin-left: auto; font-size: var(--text-sm); color: var(--text-secondary); }
  .select-field select { min-height: 36px; padding: 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-1); color: var(--text-primary); font: inherit; font-size: var(--text-sm); }

  .qcues { display: grid; }
  .qcue { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 0 var(--space-3); align-items: start; border-top: var(--hairline); }
  .qcue:first-child { border-top: 0; }
  .qcue[hidden] { display: none; }
  .qcue ask-card { min-width: 0; }
  .rmark { display: grid; place-items: center; width: 28px; height: 28px; margin-top: var(--space-3); border: 1.5px solid var(--stream-color, var(--ink)); border-radius: 2px; color: var(--text-primary); font-weight: var(--weight-semibold); font-size: var(--text-sm); line-height: 1; }
  .cues-tail { margin-top: var(--space-4); }
  @media (max-width: 480px) { .qcue { grid-template-columns: 24px minmax(0, 1fr); gap: 0 var(--space-2); } .rmark { width: 24px; height: 24px; font-size: var(--text-xs); } }
  .enter .qcue { animation: rise var(--dur-base) var(--ease-out) backwards; animation-delay: calc(var(--i, 0) * var(--stagger)); }
  @keyframes rise { from { opacity: 0; translate: 0 6px; } }
  .qcue.leaving { animation: leave var(--dur-fast) var(--ease-in-out) forwards; }
  @keyframes leave { to { opacity: 0; translate: 12px 0; } }
  @media (forced-colors: active) { .fchip[aria-pressed=true] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; } .rmark { border-color: CanvasText; } }
`;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The rehearsal letter for the nth cue: A to Z, then AA, AB and on. */
export const rehearsalLetter = (n: number): string => (n < 26 ? LETTERS[n] ?? '?' : `${rehearsalLetter(Math.floor(n / 26) - 1)}${LETTERS[n % 26]}`);

const ORDERS: [AskOrder, string][] = [['oldest', 'Oldest first'], ['oneway', 'One-way doors first'], ['stream', 'Stream']];

/** The stream the cues are narrowed to: the chosen one, unless nothing waiting belongs to it any more (then every stream, and the score does not dim). */
export const pickedStream = (st: PodiumState, extra: NeedsItem[]): string | null =>
  homeUi.stream && [...st.asks, ...extra].some((a) => a.stream === homeUi.stream) ? homeUi.stream : null;

/** The Cues section. `redraw` rebuilds Home after a control changes; `extra` are the PRs and reviews that wait on you, listed after the asks. */
export function cuesSection(st: PodiumState, live: boolean, redraw: () => void, extra: NeedsItem[] = []): HTMLElement {
  const total = st.asks.length + extra.length;
  const picked = pickedStream(st, extra);
  const shown = picked ? st.asks.filter((a) => a.stream === picked) : st.asks;
  const shownExtra = picked ? scopedItems(extra, picked) : extra;
  const set = (patch: Partial<typeof homeUi>): void => { Object.assign(homeUi, patch); PAGES.delete(CUE_KEY); redraw(); };

  const ranked = orderNeedsYou(shown, homeUi.order, todaysPriorities(st));
  const cards = ranked.map((a, i) => {
    const card = h('ask-card', {});
    card.showStream = true;
    card.locked = !live;
    card.ask = a;
    const cue = h('div', { class: `qcue ${streamVar(a.stream)}`, role: 'listitem' }, h('span', { class: 'rmark', 'aria-hidden': 'true' }, rehearsalLetter(i)), card);
    cue.style.setProperty('--i', String(Math.min(i, 8)));
    return { card, cue };
  });
  const list = cards.length ? h('div', { class: 'qcues asks', role: 'list', 'aria-label': 'Cues' }, ...cards.map((c) => c.cue)) : null;
  // One answer form open at a time: opening an ask folds the others in this list (their drafts stay).
  list?.addEventListener('ask-open', (e) => { for (const c of cards) if (c.card !== e.target) c.card.fold(); });
  // An answer sent: the cue's note flies to the coda, where the answered item will land.
  list?.addEventListener('ask-resolve', (e) => { if (e.target instanceof Element) flyNote(e.target, list.getRootNode() instanceof ShadowRoot ? (list.getRootNode() as ShadowRoot).getElementById('coda-glyph') : document.getElementById('coda-glyph')); });

  const chip = (stream: string | null, n: number): HTMLElement => {
    const b = h('button', { type: 'button', class: `fchip${stream ? ` tinted ${streamVar(stream)}` : ''}`, 'data-ctl': `chip-${stream ?? 'all'}`, 'aria-pressed': String(picked === stream) },
      stream ? h('span', { class: 'sw', 'aria-hidden': 'true' }) : null, stream ?? 'All', ' ', h('span', { class: 'c' }, String(n)));
    b.addEventListener('click', () => set({ stream }));
    return h('li', {}, b);
  };
  const byStream = st.streams.map((s) => ({ s, n: st.asks.filter((a) => a.stream === s).length + extra.filter((x) => x.stream === s).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const select = h('select', { id: 'cue-order', 'data-ctl': 'order' }, ...ORDERS.map(([k, label]) => h('option', { value: k }, label)));
  select.value = homeUi.order;
  select.addEventListener('change', () => { const next = ORDERS.find(([k]) => k === select.value); if (next) set({ order: next[0] }); });
  const controls = byStream.length > 1 || cards.length > 1
    ? h('div', { class: 'controls' },
      byStream.length > 1 ? h('ul', { class: 'chips-row', role: 'list', 'aria-label': 'Filter cues by stream' }, chip(null, total), ...byStream.map((x) => chip(x.s, x.n))) : null,
      cards.length > 1 ? h('label', { class: 'select-field', for: 'cue-order' }, 'Order', select) : null)
    : null;
  const more = pagedRows(cards.map((c) => c.cue), { key: CUE_KEY, size: CUE_PAGE, label: 'Cues' });
  const hint = live
    ? 'Questions your agents are waiting on. Open a cue to see its context and the recommendation, then send an answer, take the recommendation, or skip a two-way door. It is saved to the ledger and leaves on the next update. Cues tied to the first priority of the day come first; PRs ready to merge and reviews waiting for your OK follow.'
    : 'Sample data: cues open read-only. Answering needs the Podium server.';
  const rows = needsRows(shownExtra, true);
  return conceptSection('cues', { instrument: 'Woodwinds', title: 'Cues', n: total },
    h('p', { class: 'sec-note' }, hint), controls, list, more, cards.length === 0 && shownExtra.length === 0 ? tacet('Nothing needs you right now.', 'tacet', 'la') : null, rows ? h('div', { class: 'cues-tail' }, rows) : null);
}
