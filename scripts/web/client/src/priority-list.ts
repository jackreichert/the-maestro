import { BASE_CSS, UI_CSS, h, shadow, streamTag } from './dom.ts';
import { createEditor } from './priorities-api.ts';
import type { EditOutcome, EditRequest } from './priorities-api.ts';
import { burst, checkMark, CELEBRATE_CSS } from './priority-celebrate.ts';
import { doneClock, priorityKey } from './priority-done.ts';
import type { Celebration, PriorityStatus } from './priority-done.ts';
import { GENERIC_FAILURE, actionLabel, addBlockedReason, counter, moveItem, refuseDraft, removeItem } from './priority-edit.ts';
import type { AskBusyDetail, Priority } from './types.ts';

/** What the Overview hands the list: today's items, the cap, the stream names to suggest, and whether this page may edit at all. */
export interface PriorityData {
  items: Priority[]; max: number; streams: string[]; editable: boolean; note: string;
  /** Which priorities are done and which just became done (see priority-done.ts), and the zone their "Done at" times read in. Absent: nothing is marked done. */
  progress?: { statuses: PriorityStatus[]; celebration: Celebration; tz: string };
}

import { splitStream } from './glance.ts';
export { splitStream };

const NO_CELEBRATION: Celebration = { fresh: new Set(), before: 0, cleared: false, announce: '' };
const MAX_TEXT = 200;
const MAX_STREAM = 40;

const CSS = `${BASE_CSS}${UI_CSS}
  /* A column: the region fills whatever height the host is given and scrolls inside it; with no height given (Home today) it is as tall as its content. */
  :host { display: flex; flex-direction: column; }
  .region { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  /* A card scrolled into view by focus lands clear of the sticky header above and the fade below. */
  .region { scroll-padding-block: 2.5rem 2rem; }
  .region:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  /* Only while more sits below: a fade over the last lines, pinned to the foot of the region and taking no room of its own. */
  .fade { position: sticky; bottom: 0; block-size: 2rem; margin-block-start: -2rem; pointer-events: none; opacity: 0; background: linear-gradient(to bottom, transparent, var(--surface-page)); transition: opacity var(--dur-fast) var(--ease-out); }
  .region[data-more] .fade { opacity: 1; }
  .bar { position: sticky; top: 0; z-index: 1; background: var(--surface-page); display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-2); padding-bottom: var(--space-2); border-bottom: var(--hairline-strong); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .ttl { display: grid; }
  .instrument { font-family: var(--font-display); font-style: italic; font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--text-secondary); }
  .bar h2 { margin: 0; font-size: var(--text-xl); line-height: var(--leading-xl); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-tight); color: var(--text-primary); }
  .cap { font-variant-numeric: tabular-nums; }
  .warn { color: var(--warning); }
  ol.priorities { list-style: none; margin: 0; padding: 0; counter-reset: p; }
  ol.priorities li { counter-increment: p; display: grid; grid-template-columns: 2em minmax(0, 1fr) auto; align-items: start; gap: 0 var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
  ol.priorities li::before { content: counter(p, lower-roman) '.'; font-family: var(--font-display); font-style: italic; font-size: 1.25rem; line-height: 1.3; color: var(--text-muted); }
  /* Compact: one line per priority, the stream's tag (a link to its tab). The priority's text and epics live on that tab; the text stays here for assistive tech. */
  ol.priorities li { padding: var(--space-1) 0; align-items: center; }
  ol.priorities li::before { font-size: 1.05rem; line-height: 1.5; }
  .text.untagged { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--text-secondary); }
  @media (hover: hover) { ol.priorities li:not(:hover):not(:focus-within) .tools { opacity: 0; } }
  ol.priorities li.over { background: var(--surface-2); }
  ol.priorities li.target { box-shadow: inset 0 2px 0 var(--accent); }
  ol.priorities li.dragging { opacity: 0.5; }
  .text { min-width: 0; overflow-wrap: anywhere; }
  .tools { display: flex; align-items: center; gap: 2px; transition: opacity var(--dur-fast) var(--ease-out); }
  .tools button, .grip {
    font: inherit; font-size: var(--text-sm); line-height: 1; min-width: 28px; min-height: 28px; padding: 0 var(--space-1);
    border: 1px solid transparent; border-radius: var(--radius-sm); background: none; color: var(--text-secondary); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .grip { cursor: grab; color: var(--text-muted); touch-action: none; user-select: none; }
  @media (hover: hover) { .tools button:hover:not([disabled]) { background: var(--accent-soft); color: var(--accent); } .tools button.del:hover:not([disabled]) { background: var(--critical-soft); color: var(--critical); } }
  .tools button[disabled] { background: none; border-color: transparent; color: var(--text-muted); opacity: 0.45; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); font-size: var(--text-sm); }
  .confirm button { min-height: 28px; padding: 0 var(--space-3); }
  button.danger { border: 1px solid var(--critical); background: var(--critical); color: var(--on-accent); font: inherit; font-size: var(--text-sm); font-weight: var(--weight-semibold); border-radius: var(--radius-sm); cursor: pointer; }
  button.open-add { font: inherit; font-size: var(--text-sm); color: var(--accent); background: none; border: 0; padding: var(--space-2) 0 0; min-height: 32px; cursor: pointer; text-align: left; }
  button.open-add[disabled] { background: none; color: var(--text-muted); }
  @media (hover: hover) { button.open-add:hover:not([disabled]) { text-decoration: underline; } }
  form.add { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); padding-top: var(--space-3); }
  @media (min-width: 480px) { form.add { grid-template-columns: minmax(0, 1fr) minmax(0, 10em) auto; align-items: end; } }
  form.add label { display: grid; gap: 2px; font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-secondary); }
  form.add input {
    font: inherit; font-size: var(--text-sm); min-height: 36px; padding: 0 var(--space-2); color: var(--text-primary); background: var(--surface-1);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); min-width: 0;
  }
  form.add input[disabled] { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); cursor: not-allowed; }
  .msg { margin: var(--space-2) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); min-height: var(--leading-sm); }
  .msg.err { color: var(--critical); }
  .hint { margin: var(--space-2) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  @media (forced-colors: active) { .fade { display: none; } .tools button, .grip { border: 1px solid ButtonText; } ol.priorities li.target { box-shadow: inset 0 2px 0 Highlight; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  ${CELEBRATE_CSS}
`;

/**
 * A full-page redraw builds a new <priority-list>, so the region's scroll offset is read from the old one first.
 * Call before the redraw; call the result after it to put the offset back on the new region.
 */
export function keepRegionScroll(page: ParentNode): () => void {
  const region = (): HTMLElement | null => page.querySelector('priority-list')?.shadowRoot?.querySelector<HTMLElement>('.region') ?? null;
  const top = region()?.scrollTop ?? 0;
  return () => { const r = region(); if (r && top > 0) r.scrollTop = top; };
}

/**
 * <priority-list>: today's priorities, and (when the page may edit) the controls to reorder, delete and add them.
 *
 * The server's file is the truth. A change shows at once (optimistic), the request goes out, and the server's own list
 * replaces the guess when it answers; a refusal puts the list back as the server has it and says why. Reorder is a drag by
 * the handle, or the move up and move down buttons, which are the keyboard and screen reader path. Delete asks first, inline.
 * While a request is in flight or a drag is under way the element tells the page to hold live redraws (`ask-busy`), so the
 * list is not replaced under the pointer. Text is only ever set with textContent.
 */
export class PriorityList extends HTMLElement {
  #root: ShadowRoot;
  /** The one scroll region, made once: redraws replace what is inside it, so its scroll position and focus survive them. */
  #region: HTMLElement = h('div', { class: 'region', id: 'pl-region', role: 'region', tabindex: '0', 'aria-label': 'Today\'s priorities' });
  #resize: ResizeObserver | null = null;
  #data: PriorityData = { items: [], max: 5, streams: [], editable: false, note: '' };
  #items: Priority[] = [];
  #max = 5;
  #confirm = -1;
  #pending = false;
  #adding = false;   // the add form is folded behind "+ Add a priority" until asked for
  #drag = -1;
  #over = -1;
  #message: { text: string; error: boolean } = { text: '', error: false };
  #focus: string | null = null;
  #announce: ReturnType<typeof setTimeout> | null = null;
  #dragHold = false;   // the drag's own hold on redraws; released once, by whichever of drop or dragend comes first
  #holds = 0;   // reasons to hold the page's redraws: a drag, a request; the page is told only on 0 to 1 and 1 to 0
  #draft = { text: '', stream: '' };
  readonly #editor = createEditor();

  constructor() {
    super();
    this.#root = shadow(this, CSS);
    this.#root.append(this.#region);
    this.#region.addEventListener('scroll', () => this.#syncFade(), { passive: true });
  }

  set data(d: PriorityData) {
    this.#data = d;
    this.#items = d.items;
    this.#max = d.max;
    if (this.isConnected) this.#render(d.progress?.celebration);
  }

  connectedCallback(): void {
    this.#render(this.#data.progress?.celebration);
    // The host's height follows the page (the hero row), so whether more sits below changes without any redraw.
    if (typeof ResizeObserver === 'function') { this.#resize = new ResizeObserver(() => this.#syncFade()); this.#resize.observe(this); }
  }

  disconnectedCallback(): void {
    this.#resize?.disconnect();
    this.#resize = null;
    if (this.#announce !== null) clearTimeout(this.#announce);
  }

  /** Show the bottom fade only while there is more to scroll to. */
  #syncFade(): void {
    const r = this.#region;
    r.toggleAttribute('data-more', r.scrollHeight - r.scrollTop - r.clientHeight > 1);
  }

  /** Tell the page to hold its live redraws (or stop holding them): the same signal an ask card sends while it works. */
  #busy(on: boolean): void {
    this.#holds += on ? 1 : -1;
    if (this.#holds === 1 && on) this.#signal(true);
    else if (this.#holds === 0) this.#signal(false);
  }

  #signal(busy: boolean): void {
    this.dispatchEvent(new CustomEvent<AskBusyDetail>('ask-busy', { detail: { busy }, bubbles: true, composed: true }));
  }

  #say(text: string, error = false): void { this.#message = { text, error }; }

  /** Show `next` now, send `req`, then show what the server says; a refusal shows its reason and the server's list. */
  /** Resolves true when the server accepted the change. */
  async #apply(next: Priority[], req: EditRequest, focus: string | null): Promise<boolean> {
    if (this.#pending) return false;
    const before = this.#items;
    this.#items = next;
    this.#confirm = -1;
    this.#pending = true;
    this.#say('Saving…');
    this.#focus = focus;
    this.#busy(true);
    this.#render();
    const out: EditOutcome = await this.#editor.send(req);
    this.#pending = false;
    if (out.ok) {
      this.#items = out.items;
      if (out.max !== undefined) this.#max = out.max;
      this.#say('');
    } else {
      this.#items = out.items ?? before;
      if (out.max !== undefined) this.#max = out.max;
      this.#say(out.message || GENERIC_FAILURE, true);
    }
    this.#render();
    this.#busy(false);
    return out.ok;
  }

  #move(from: number, to: number, focus: string | null): void {
    const item = this.#items[from];
    if (!item || to < 0 || to >= this.#items.length || to === from) return;
    void this.#apply(moveItem(this.#items, from, to), { op: 'move', from, to, text: item.text }, focus);
  }

  #delete(index: number): void {
    const item = this.#items[index];
    if (!item) return;
    const rest = this.#items.length - 1;
    void this.#apply(removeItem(this.#items, index), { op: 'delete', index, text: item.text }, rest === 0 ? 'pl-text' : `pl-del-${Math.min(index, rest - 1)}`);
  }

  #add(): void {
    const text = this.#draft.text.replace(/\s+/g, ' ').trim();
    const stream = this.#draft.stream.trim();
    if (!text || this.#pending || addBlockedReason(this.#items.length, this.#max)) return;
    const refusal = refuseDraft(text);
    if (refusal) { this.#say(refusal, true); this.#focus = 'pl-text'; this.#render(); return; }
    const kept = this.#draft;
    this.#draft = { text: '', stream: '' };
    const item: Priority = stream ? { text, stream } : { text };
    void this.#apply([...this.#items, item], { op: 'add', text, ...(stream ? { stream } : {}) }, this.#items.length + 1 >= this.#max ? `pl-del-${this.#items.length}` : 'pl-text').then((ok) => {
      if (ok) return;
      this.#draft = kept;   // a refused add keeps what was typed, so it can be fixed rather than retyped
      this.#render();
    });
  }

  /** `celebration` is given only by a fresh `data`: that draw plays it, and every internal redraw (a confirm, a drag, an edit) gets none, so nothing replays. */
  #render(celebration: Celebration = NO_CELEBRATION): void {
    // Whatever has focus keeps it across the rebuild (by id), unless a caller named where focus should land.
    const want = this.#focus ?? this.#root.activeElement?.id ?? null;
    this.#focus = null;
    const { editable, streams, note } = this.#data;
    const items = this.#items;
    const c = counter(items.length, this.#max);
    const blocked = addBlockedReason(items.length, this.#max);
    const frag: Node[] = [];
    frag.push(h('div', { class: 'bar' },
      h('div', { class: 'ttl' }, h('span', { class: 'instrument', 'aria-hidden': 'true' }, 'Liner notes'), h('h2', {}, 'Today\'s priorities')),
      h('span', { class: 'cap', id: 'pl-count' }, h('span', { class: 'vh' }, 'Priorities: '), c.label),
      this.#meter(celebration),
      c.over ? h('span', { class: 'warn' }, `Over the cap of ${this.#max}: you can reorder and remove, not add.`) : null));
    if (items.length === 0) frag.push(h('p', { class: 'empty' }, note || 'No priorities set for today.'));
    else {
      const list = h('ol', { class: 'priorities', role: 'list', 'aria-describedby': 'pl-count' }, ...items.map((p, i) => this.#row(p, i, editable, celebration)));
      list.setAttribute('aria-busy', String(this.#pending));
      frag.push(list);
    }
    if (editable && !this.#adding) {
      const open = h('button', { type: 'button', class: 'open-add', id: 'pl-open', 'aria-describedby': blocked ? 'pl-hint' : undefined }, '+ Add a priority');
      open.disabled = blocked !== null;
      open.addEventListener('click', () => { this.#adding = true; this.#focus = 'pl-text'; this.#render(); });
      frag.push(open);
      if (blocked) frag.push(h('p', { class: 'hint', id: 'pl-hint' }, blocked));
      frag.push(h('div', { class: `msg${this.#message.error ? ' err' : ''}`, role: this.#message.error ? 'alert' : 'status' }, this.#message.text));
    } else if (editable) {
      const dl = h('datalist', { id: 'pl-streams' }, ...streams.map((s) => h('option', { value: s })));
      const text = h('input', { id: 'pl-text', type: 'text', maxlength: String(MAX_TEXT), autocomplete: 'off', required: true, 'aria-describedby': blocked ? 'pl-hint' : undefined });
      const stream = h('input', { id: 'pl-stream', type: 'text', list: 'pl-streams', maxlength: String(MAX_STREAM), autocomplete: 'off' });
      text.value = this.#draft.text;
      stream.value = this.#draft.stream;
      text.disabled = stream.disabled = blocked !== null;
      text.addEventListener('input', () => { this.#draft.text = text.value; });
      stream.addEventListener('input', () => { this.#draft.stream = stream.value; });
      const add = h('button', { type: 'submit', class: 'primary', id: 'pl-add' }, 'Add');
      add.disabled = blocked !== null;
      const form = h('form', { class: 'add', autocomplete: 'off' },
        h('label', {}, 'New priority', text), h('label', {}, 'Stream (optional)', stream, dl), add);
      form.addEventListener('submit', (e) => { e.preventDefault(); this.#add(); });
      form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.#adding = false; this.#focus = 'pl-open'; this.#render(); } });
      frag.push(form);
      if (blocked) frag.push(h('p', { class: 'hint', id: 'pl-hint' }, blocked));
      frag.push(h('div', { class: `msg${this.#message.error ? ' err' : ''}`, role: this.#message.error ? 'alert' : 'status' }, this.#message.text));
    }
    frag.push(this.#live(celebration));
    this.#region.replaceChildren(...frag, h('div', { class: 'fade', 'aria-hidden': 'true' }));
    this.#syncFade();
    if (want) (this.#root.getElementById(want) as HTMLElement | null)?.focus();
  }

  /** "3 of 5 done" with a bar that fills forward from where it stood, and the "Board cleared" line once every priority is done. */
  #meter(cel: Celebration): HTMLElement | null {
    const prog = this.#data.progress;
    const total = this.#items.length;
    if (!prog || total === 0) return null;
    const byKey = new Map(prog.statuses.map((x) => [x.key, x]));
    const n = this.#items.filter((p) => byKey.get(priorityKey(p))?.done).length;
    const fresh = cel.fresh.size > 0;
    const full = n === total;
    const before = Math.min(Math.max(cel.before, 0), n);
    const fill = h('span', { class: 'fill' });
    fill.style.setProperty('--p', String(n / total));
    fill.style.setProperty('--from', String(before / total));
    const meter = h('span', { class: `meter${full ? ' full' : ''}${fresh ? ' fresh' : ''}`, id: 'pl-meter' },
      h('span', { class: 'count' }, h('span', { class: 'vh' }, 'Progress: '), `${n} of ${total} done`),
      h('span', { class: 'track', 'aria-hidden': 'true' }, fill));
    const spark = full && cel.cleared ? burst(true) : null;
    if (spark) meter.append(spark);
    if (!full) return meter;
    return h('span', { class: 'ttl-done' }, meter, h('span', { class: `cleared${cel.cleared ? ' fresh' : ''}`, id: 'pl-cleared' }, 'Board cleared ', h('span', { 'aria-hidden': 'true' }, '✓')));
  }

  /** The announcement for a screen reader. Its words go in just after it is on the page, because a live region only speaks changes. */
  #live(cel: Celebration): HTMLElement {
    const live = h('div', { class: 'vh', id: 'pl-live', role: 'status', 'aria-live': 'polite' });
    const said = cel.announce;
    if (said) {
      if (this.#announce !== null) clearTimeout(this.#announce);
      this.#announce = setTimeout(() => { live.textContent = said; this.#announce = null; }, 60);
    }
    return live;
  }

  /** The check (with its burst when fresh) and the "Done at" time. A screen reader hears "Done at 3:42 pm ET"; the check itself is decoration. */
  #doneMarks(status: PriorityStatus, fresh: boolean): Node[] {
    const clock = doneClock(status.doneAt, this.#data.progress?.tz ?? '');
    const chk = h('span', { class: 'chk' }, checkMark(fresh));
    const spark = fresh ? burst(false) : null;
    if (spark) chk.append(spark);
    return [chk, h('span', { class: 'when' }, clock ? `Done ✓ at ${clock}` : 'Done ✓')];
  }

  #row(p: Priority, i: number, editable: boolean, cel: Celebration): HTMLElement {
    const shown = splitStream(p);
    const status = this.#data.progress?.statuses.find((x) => x.key === priorityKey(p));
    const done = status?.done === true;
    // Only the stream is drawn; the full text stays in the page for assistive tech and as a tooltip. A priority whose stream has no tab (none, or one nobody has opened) has nowhere else to show its text, so it is drawn, on one line.
    const hasTab = shown.stream !== '' && this.#data.streams.includes(shown.stream);
    const text = hasTab
      ? h('span', { class: 'text', title: shown.text }, streamTag(shown.stream), h('span', { class: 'vh' }, `: ${shown.text}`))
      : h('span', { class: 'text untagged', title: shown.text }, shown.text);
    if (done && status) { text.classList.add('done'); text.append(...this.#doneMarks(status, cel.fresh.has(status.key))); }
    const li = h('li', { 'data-i': String(i), ...(done ? { class: status && cel.fresh.has(status.key) ? 'done fresh' : 'done' } : {}) }, text);
    if (!editable) return li;
    if (this.#confirm === i) {
      const yes = h('button', { type: 'button', class: 'danger', id: `pl-yes-${i}`, 'aria-label': actionLabel('Confirm delete', p) }, 'Delete');
      const no = h('button', { type: 'button', class: 'secondary', id: `pl-no-${i}` }, 'Keep');
      yes.addEventListener('click', () => this.#delete(i));
      no.addEventListener('click', () => { this.#confirm = -1; this.#focus = `pl-del-${i}`; this.#render(); });
      li.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.#confirm = -1; this.#focus = `pl-del-${i}`; this.#render(); } });
      li.append(h('span', { class: 'confirm', role: 'group', 'aria-label': actionLabel('Delete', p) }, 'Delete this?', yes, no));
      queueMicrotask(() => no.focus());
      return li;
    }
    const last = this.#items.length - 1;
    const up = h('button', { type: 'button', id: `pl-up-${i}`, 'aria-label': actionLabel('Move up', p), title: 'Move up' }, '↑');
    const down = h('button', { type: 'button', id: `pl-down-${i}`, 'aria-label': actionLabel('Move down', p), title: 'Move down' }, '↓');
    const del = h('button', { type: 'button', class: 'del', id: `pl-del-${i}`, 'aria-label': actionLabel('Delete', p), title: 'Delete' }, '✕');
    up.disabled = i === 0;
    down.disabled = i === last;
    up.addEventListener('click', () => this.#move(i, i - 1, i - 1 === 0 ? `pl-down-${i - 1}` : `pl-up-${i - 1}`));
    down.addEventListener('click', () => this.#move(i, i + 1, i + 1 === last ? `pl-up-${i + 1}` : `pl-down-${i + 1}`));
    del.addEventListener('click', () => { this.#confirm = i; this.#render(); });
    const grip = h('span', { class: 'grip', draggable: 'true', 'aria-hidden': 'true', title: 'Drag to reorder' }, '⠿');
    grip.addEventListener('dragstart', (e) => {
      this.#drag = i;
      li.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(i));
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setDragImage(li, 8, 8); }
      this.#dragHold = true;
      this.#busy(true);
    });
    // A drop rebuilds the list, which removes the grip that started the drag, and some browsers then never send dragend.
    const endDrag = (): void => {
      this.#drag = -1;
      this.#over = -1;
      if (!this.#dragHold) return;
      this.#dragHold = false;
      this.#busy(false);
    };
    grip.addEventListener('dragend', () => { endDrag(); this.#render(); });
    li.addEventListener('dragover', (e) => {
      if (this.#drag < 0) return;
      e.preventDefault();
      if (this.#over !== i) {
        this.#root.querySelectorAll('li.target').forEach((el) => el.classList.remove('target'));
        li.classList.add('target');
        this.#over = i;
      }
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.#drag;
      this.#move(from, i, i === 0 ? `pl-down-${i}` : `pl-up-${i}`);
      endDrag();
    });
    li.append(h('span', { class: 'tools' }, grip, up, down, del));
    return li;
  }
}

customElements.define('priority-list', PriorityList);

declare global { interface HTMLElementTagNameMap { 'priority-list': PriorityList } }
