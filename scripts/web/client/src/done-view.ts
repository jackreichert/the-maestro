/**
 * The top of a stream tab: what done looks like for the stream, read from the files that say it (an epic's or a project's
 * "What done looks like"), with progress where it can be counted and a Fine mark when it is met. Each definition has an Edit button that
 * opens its markdown in a textarea and saves it back to the note it was read from (done-api.ts); a stream with no definition says which
 * file to add one to and offers to write it. The page sends a stream and a source, never a path.
 */
import { createDoneApi } from './done-api.ts';
import type { DoneApi, DoneRef } from './done-api.ts';
import { h, refLink } from './dom.ts';
import { sectionHead } from './home-concept.ts';
import { pagedRows } from './pager.ts';
import type { AskBusyDetail, DoneCriterion, DoneSource, StreamHome } from './types.ts';

export const DONE_PAGE = 5;

export const DONE_CSS = `
  .done-top { width: min(760px, 100%); margin-inline: auto; }
  .done-top .sec-head { justify-content: center; text-align: center; }
  .done-top .sec-title { justify-items: center; }
  .done-card { padding: var(--card-pad); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-1); }
  .done-cards { display: grid; gap: var(--space-4); }
  .done-cards > * { margin: 0; }
  .done-card .dc-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); }
  .done-card .dc-name { font-family: var(--font-mono); font-size: var(--text-sm); }
  .done-card .dc-kind { color: var(--text-muted); font-size: var(--text-xs); }
  .done-card .dc-count { margin-left: auto; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .done-card .dc-bar { height: 4px; margin: var(--space-2) 0 var(--space-3); border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .done-card .dc-bar > span { display: block; height: 100%; background: var(--accent); }
  .done-card.finished .dc-bar > span { background: var(--success, var(--accent)); }
  .done-card .dc-prose { margin: 0; font-size: var(--text-md); line-height: var(--leading-md); max-width: 62ch; }
  .done-card ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
  .done-card li { display: grid; grid-template-columns: 1.4em minmax(0, 1fr); gap: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .done-card li .mk { color: var(--text-muted); text-align: center; }
  .done-card li.on { color: var(--text-primary); }
  .done-card li.on .mk { color: var(--accent); }
  .done-card .dc-more { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  .fine { font-family: var(--font-display); font-style: italic; font-size: var(--text-md); color: var(--text-primary); white-space: nowrap; }
  .fine .bar { font-style: normal; letter-spacing: -0.1em; }
  .dc-edit { margin-left: var(--space-2); font: inherit; font-size: var(--text-xs); color: var(--text-secondary); min-height: 24px; padding: 0 var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: none; cursor: pointer; }
  .dc-edit:focus-visible, .done-edit textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .dc-edit[disabled] { cursor: default; opacity: 0.6; }
  @media (hover: hover) { .dc-edit:hover:not([disabled]) { background: var(--surface-2); color: var(--text-primary); } }
  .done-edit { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
  .done-edit label { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  .done-edit textarea { width: 100%; min-height: 160px; resize: vertical; font-family: var(--font-mono); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-primary); background: var(--surface-page); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); box-sizing: border-box; }
  .done-edit textarea[aria-invalid=true] { border-color: var(--critical); }
  .done-edit .de-hint { margin: 0; font-size: var(--text-xs); color: var(--text-muted); }
  .done-edit .de-error { margin: 0; font-size: var(--text-sm); color: var(--critical); }
  .done-edit .de-error[hidden] { display: none; }
  .done-edit .de-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .done-edit button { font: inherit; font-size: var(--text-sm); min-height: 32px; padding: 0 var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: none; color: var(--text-primary); cursor: pointer; }
  .done-edit button.primary { background: var(--accent); color: var(--on-accent, var(--surface-page)); border-color: var(--accent); }
  .done-edit button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .done-saved, .done-edit-error { margin: var(--space-2) 0 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .done-edit-error { color: var(--critical); }
  .done-saved:focus { outline: none; }
  .done-empty { margin: 0 auto; max-width: 60ch; text-align: center; font-size: var(--text-sm); color: var(--text-muted); }
`;

const progressWords = (p: NonNullable<DoneSource['progress']>): string =>
  p.unit === 'checked' ? `${p.done} of ${p.total} checked` : `${p.done} of ${p.total} ${p.total === 1 ? 'ticket' : 'tickets'} closed`;

function criterion(c: DoneCriterion): HTMLElement {
  const mark = c.checked === null ? '•' : c.checked ? '✓' : '○';
  return h('li', { class: c.checked ? 'on' : '' }, h('span', { class: 'mk', 'aria-hidden': 'true' }, mark),
    h('span', {}, c.checked === null ? null : h('span', { class: 'vh' }, c.checked ? 'Done: ' : 'Open: '), c.text));
}

/** The filled part of a progress bar; the width is set on the element, so no inline style attribute is needed. */
function bar(pct: number): HTMLElement {
  const fill = h('span', {});
  fill.style.width = `${pct}%`;
  return fill;
}

/** What the page remembers across a redraw, keyed by stream and source: the editor that was open and the text typed in it. */
const open = new Map<string, { rev: string; text: string }>();
/** Forget it all; for tests, which share one module. */
export function forgetDoneEdits(): void { open.clear(); }
/** The calls the editor makes; replaced in tests. */
export const doneBackend: { api: DoneApi } = { api: createDoneApi() };

const keyOf = (r: DoneRef): string => `${r.stream}\u0000${r.kind}\u0000${r.name}`;
let seq = 0;

/**
 * The editor for one definition: a labelled textarea, Save and Cancel, and an error line. Ctrl or Cmd Enter saves and Escape cancels.
 * `onDone` is called with whether the text was saved, after the form has removed itself.
 */
function editor(ref: DoneRef, label: string, start: { rev: string; text: string }, onDone: (saved: boolean) => void): HTMLElement {
  const uid = `de-${++seq}`;
  const field = h('textarea', { id: `${uid}-t`, rows: '8', 'aria-describedby': `${uid}-h`, spellcheck: 'true' });
  field.value = start.text;
  const error = h('p', { class: 'de-error', id: `${uid}-e`, role: 'alert', hidden: true });
  const describedBy = field.getAttribute('aria-describedby') ?? '';
  const save = h('button', { type: 'button', class: 'primary' }, 'Save');
  const cancel = h('button', { type: 'button' }, 'Cancel');
  const form = h('div', { class: 'done-edit', role: 'group', 'aria-labelledby': `${uid}-l` },
    h('label', { id: `${uid}-l`, for: `${uid}-t` }, `Edit what done looks like: ${label}`), field,
    h('p', { class: 'de-hint', id: `${uid}-h` }, 'Markdown. Only this section of the note is replaced. Ctrl or Cmd Enter saves; Escape cancels.'),
    error, h('div', { class: 'de-actions' }, save, cancel));
  const key = keyOf(ref);
  open.set(key, start);
  const showError = (message: string | null): void => {
    error.textContent = message ?? '';
    error.hidden = message === null;
    if (message === null) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-errormessage'); field.setAttribute('aria-describedby', describedBy); return; }
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-errormessage', error.id);
    field.setAttribute('aria-describedby', `${describedBy} ${error.id}`);
  };
  field.addEventListener('input', () => { open.set(key, { rev: start.rev, text: field.value }); if (!error.hidden) showError(null); });
  let pending = false;
  const busy = (on: boolean): void => {
    save.toggleAttribute('disabled', on);
    cancel.toggleAttribute('disabled', on);
    form.dispatchEvent(new CustomEvent<AskBusyDetail>('ask-busy', { detail: { busy: on }, bubbles: true, composed: true }));
  };
  const submit = async (): Promise<void> => {
    if (pending) return;
    if (!field.value.trim()) { showError('Write what done looks like first. An empty definition would delete it.'); field.focus(); return; }
    pending = true;
    busy(true);
    const out = await doneBackend.api.save(ref, start.rev, field.value);
    pending = false;
    busy(false);
    if (out.ok) { open.delete(key); form.remove(); onDone(true); return; }
    showError(out.message);
    field.focus();
  };
  const close = (): void => { if (pending) return; open.delete(key); form.remove(); onDone(false); };
  save.addEventListener('click', () => { void submit(); });
  cancel.addEventListener('click', close);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  return form;
}

/**
 * An Edit control for `ref`: a button that loads the raw section and opens the editor in `host`, hiding `view` meanwhile. After a save it
 * says so in `host`; the new text shows when the page's next update arrives. A redraw while the editor is open reopens it with the typed text.
 */
function editControl(ref: DoneRef, label: string, text: string, host: HTMLElement, view: HTMLElement[]): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'dc-edit', 'aria-label': `${text} ${label}` }, text);
  const status = h('p', { class: 'done-edit-error', role: 'alert', hidden: true });
  host.append(status);
  const show = (hidden: boolean): void => { for (const n of view) n.hidden = hidden; button.hidden = hidden; };
  const openWith = (start: { rev: string; text: string }): void => {
    status.hidden = true;
    show(true);
    const form = editor(ref, label, start, (saved) => {
      show(false);
      if (saved) {
        const ok = h('p', { class: 'done-saved', role: 'status', tabindex: '-1' }, 'Saved. The new text shows when the page next updates.');
        host.append(ok);
        ok.focus();
      } else button.focus();
    });
    host.append(form);
    form.querySelector('textarea')?.focus();
  };
  button.addEventListener('click', async () => {
    button.toggleAttribute('disabled', true);
    host.querySelector('.done-saved')?.remove();
    const out = await doneBackend.api.load(ref);
    button.toggleAttribute('disabled', false);
    if (out.ok) openWith({ rev: out.rev, text: out.text });
    else { status.textContent = out.message; status.hidden = false; }
  });
  const prior = open.get(keyOf(ref));
  if (prior) queueMicrotask(() => { if (host.isConnected && !host.querySelector('.done-edit')) openWith(prior); });
  return button;
}

function card(s: DoneSource, stream: string): HTMLElement {
  const p = s.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const view: HTMLElement[] = [];
  if (p) view.push(h('div', { class: 'dc-bar', 'aria-hidden': 'true' }, bar(pct)));
  if (s.prose) view.push(h('p', { class: 'dc-prose' }, s.prose));
  if (s.items.length) view.push(h('ul', { role: 'list' }, ...s.items.map(criterion)));
  if (s.more > 0) view.push(h('p', { class: 'dc-more' }, `${s.more} more not listed.`));
  const el = h('div', { class: `done-card${s.finished ? ' finished' : ''}`, role: 'listitem' },
    h('div', { class: 'dc-head' },
      h('span', { class: 'dc-name' }, refLink({ label: s.name, ...(s.ref.url ? { url: s.ref.url } : {}) })),
      h('span', { class: 'dc-kind' }, s.kind === 'epic' ? 'epic' : 'project note'),
      s.finished ? h('span', { class: 'fine' }, h('i', { lang: 'it' }, 'Fine'), ' ', h('span', { class: 'bar', 'aria-hidden': 'true' }, '❙❙'), h('span', { class: 'vh' }, ', met')) : null,
      p ? h('span', { class: 'dc-count' }, progressWords(p)) : null),
    ...view);
  const button = editControl({ stream, kind: s.kind, name: s.name }, s.name, 'Edit', el, view);
  el.querySelector('.dc-head')?.append(button);
  return el;
}

/** The stream's definition of done: one card per written source, paged, or the file to add one to with a button that writes it. */
export function doneTop(home: StreamHome): HTMLElement {
  const id = `done-${home.stream.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const { sources, fix } = home.done;
  const cards = sources.map((s) => card(s, home.stream));
  const more = pagedRows(cards, { key: `done:${home.stream}`, size: DONE_PAGE, label: 'What done looks like', noun: 'definitions' });
  const hasEpic = home.epics.some((e) => e.status !== 'closed');
  let empty: HTMLElement | null = null;
  if (!cards.length) {
    empty = h('div', { class: 'done-empty' }, h('p', { class: 'done-empty-text' }, fix ?? 'Nothing says what done looks like for this stream.', ' ', h('i', { lang: 'la' }, 'tacet')));
    if (hasEpic) empty.append(editControl({ stream: home.stream, kind: 'new', name: '' }, home.stream, 'Write it here', empty, [empty.firstElementChild as HTMLElement]));
  }
  return h('section', { class: 'section done-top', 'aria-labelledby': id },
    sectionHead({ instrument: 'Cadence', title: 'What done looks like', id, n: sources.length || null }),
    cards.length ? h('div', { class: 'done-cards', role: 'list', 'aria-label': 'Definitions of done' }, ...cards) : empty,
    more);
}
