import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { createScriptActions, loadScriptSource, loadScripts } from './scripts-api.ts';
import type { ScriptActions, ScriptRow, SourceRow } from './scripts-api.ts';
import { DASHBOARD, formatFragment } from './tabs.ts';

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; }
  section.group { margin-block: var(--space-5); }
  h3.group-name { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 0 0 var(--space-2); }
  article { border-bottom: 1px solid var(--border); padding-block: var(--space-4); }
  article.target { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: var(--radius-xs); }
  .top { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; }
  .top h4 { margin: 0; font-size: var(--text-md); }
  .badge { border: var(--hairline-strong); border-radius: var(--radius-xs); padding: 0 6px; font-size: var(--text-xs); color: var(--text-secondary); }
  dl.facts { display: grid; grid-template-columns: max-content minmax(0, 70ch); gap: var(--space-1) var(--space-3); margin: var(--space-3) 0; }
  dl.facts dt { color: var(--text-muted); font-size: var(--text-sm); }
  dl.facts dd { margin: 0; color: var(--text-primary); }
  .code { display: grid; gap: var(--space-1); margin-block: var(--space-2); }
  pre { margin: 0; padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius-xs); overflow-x: auto; font-family: var(--font-mono); font-size: var(--text-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
  .meta { color: var(--text-muted); font-size: var(--text-sm); margin: var(--space-1) 0; }
  .note { color: var(--text-secondary); max-width: 70ch; }
  .msg { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--text-secondary); }
  details.source { margin-block: var(--space-2); }
  details.source > summary, details.history > summary { cursor: pointer; }
  details.source > summary { font-size: var(--text-sm); color: var(--text-secondary); }
  .file { margin-block: var(--space-3); }
  .file .sum { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; margin: 0 0 var(--space-1); font-size: var(--text-sm); color: var(--text-muted); }
  .file .sum code { color: var(--text-primary); overflow-wrap: anywhere; }
  .badge.warn { border-color: var(--warning); background: var(--warning-soft); color: var(--warning); }
  .badge.mutates { border-color: var(--critical); color: var(--critical); }
  .badge.gate { border-color: var(--success); color: var(--success); }
  pre.src { padding: var(--space-3) 0; white-space: pre; overflow-wrap: normal; max-height: 60vh; overflow: auto; }
  pre.src .ln { display: block; padding-inline: var(--space-3); border-inline-start: 3px solid transparent; }
  pre.src .ln::before { content: attr(data-n); display: inline-block; min-width: 4ch; margin-inline-end: var(--space-3); text-align: right; color: var(--text-muted); }
  pre.src .ln.mutates { background: var(--warning-soft); border-inline-start-color: var(--critical); font-weight: 700; }
  pre.src .ln.gate { background: var(--accent-soft); border-inline-start-color: var(--success); font-weight: 600; }
  .hiddenfile { margin: 0; padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius-xs); color: var(--text-secondary); }
  details.history > summary { cursor: pointer; font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
`;

/** Which History folds are open, and any message under a card: kept for the page's life, because a live update rebuilds the tab. */
let historyOpen = false;
const messages = new Map<string, string>();
const sourceOpen = new Set<string>();
const sources = new Map<string, SourceRow[] | null>();
/** Forget the kept state (tests). */
export const clearScriptQueueState = (): void => { historyOpen = false; messages.clear(); sourceOpen.clear(); sources.clear(); };

const WHEN: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', WHEN); };
const RESULT: Record<string, string> = { done: 'succeeded', failed: 'failed', killed: 'was stopped', timeout: 'timed out' };
const VIA: Record<string, string> = { podium: 'run on the Podium', marked: 'marked done by you', cli: 'recorded from the command line' };

/** The script id a `#tab=scripts&script=<id>` fragment points at, or null. */
export function targetOf(hash: string): string | null {
  const v = hash.replace(/^#/, '').split('&').find((p) => p.startsWith('script='))?.slice(7);
  try { return v ? decodeURIComponent(v) : null; } catch { return null; }
}

/**
 * <script-queue>: the scripts the user is blocked on. "Blocked on you" first (each with its Needs-you ask), then "Reusable", then a collapsed "History".
 * Every card shows what it does, why it is needed and what happens after, then the exact command in a code block with a copy button. The page never runs
 * a command: the Run button lives on the ask's card (reviewed-run route), and "Mark done (I ran it)" only records that you ran it yourself.
 */
export class ScriptQueueElement extends HTMLElement {
  #root: ShadowRoot;
  #actions: ScriptActions | null = null;
  #rows: ScriptRow[] | null = null;
  #load: () => Promise<ScriptRow[] | null> = () => loadScripts();
  #loadSource: (id: string) => Promise<SourceRow[] | null> = (id) => loadScriptSource(id);

  constructor() { super(); this.#root = shadow(this, CSS); }

  /** Tests pass fakes; the defaults talk to the server. */
  set actions(v: ScriptActions) { this.#actions = v; }
  set loader(v: () => Promise<ScriptRow[] | null>) { this.#load = v; }
  set sourceLoader(v: (id: string) => Promise<SourceRow[] | null>) { this.#loadSource = v; }

  connectedCallback(): void { void this.refresh(); }

  async refresh(): Promise<void> {
    this.#rows = await this.#load();
    this.#render();
  }

  #render(): void {
    if (!this.#rows) { this.#root.replaceChildren(h('p', { class: 'note', role: 'alert' }, 'The scripts could not be loaded.')); return; }
    const by = (s: ScriptRow['status']): ScriptRow[] => this.#rows?.filter((r) => r.status === s) ?? [];
    const target = targetOf(location.hash);
    const group = (name: string, rows: ScriptRow[], empty: string): HTMLElement => h('section', { class: 'group', 'aria-label': name },
      h('h3', { class: 'group-name' }, `${name} (${rows.length})`), ...(rows.length ? rows.map((r) => this.#card(r, target)) : [h('p', { class: 'note' }, empty)]));
    const history = by('history');
    const fold = h('details', { class: 'history', ...(historyOpen ? { open: true } : {}) }, h('summary', {}, `History (${history.length})`), ...history.map((r) => this.#card(r, target)));
    fold.addEventListener('toggle', () => { historyOpen = fold.open; });
    this.#root.replaceChildren(
      group('Blocked on you', by('blocked'), 'Nothing is waiting on you.'),
      group('Reusable', by('reusable'), 'No reusable scripts yet.'),
      h('section', { class: 'group', 'aria-label': 'History' }, ...(history.length ? [fold] : [h('p', { class: 'note' }, 'History is empty.')])));
    if (target) this.#root.querySelector<HTMLElement>(`article[data-id="${CSS_ESCAPE(target)}"]`)?.scrollIntoView?.({ block: 'center' });
  }

  /**
   * The source of the files this command runs, in a fold that is closed until opened. Read-only: the page only displays text it was sent, by textContent.
   * The fetch happens when the fold opens (and again on each rebuild while it stays open), so a closed fold costs nothing and an open one is never stale.
   */
  #source(r: ScriptRow): HTMLElement {
    const body = h('div', { class: 'source-body' });
    const fold = h('details', { class: 'source', ...(sourceOpen.has(r.id) ? { open: true } : {}) }, h('summary', {}, 'Script source (read-only)'), body);
    const fill = async (): Promise<void> => {
      body.replaceChildren(h('p', { class: 'note', role: 'status' }, 'Loading the source...'));
      const files = await this.#loadSource(r.id);
      sources.set(r.id, files);
      if (!fold.open) return;
      body.replaceChildren(...(files === null ? [h('p', { class: 'note', role: 'alert' }, 'The source could not be loaded.')] : files.length === 0 ? [h('p', { class: 'note' }, 'This command runs no script file the page can read.')] : files.map((f) => this.#file(r, f))));
    };
    fold.addEventListener('toggle', () => { if (fold.open) { sourceOpen.add(r.id); void fill(); } else sourceOpen.delete(r.id); });
    if (fold.open) void fill();
    return fold;
  }

  #file(r: ScriptRow, f: SourceRow): HTMLElement {
    const when = f.modified ? new Date(f.modified) : null;
    const sum = h('p', { class: 'sum' },
      h('code', {}, f.path),
      f.role === 'include' ? h('span', { class: 'badge' }, 'include') : null,
      h('span', {}, plural(f.lines, 'line')),
      h('span', { class: 'badge mutates' }, `${f.mutates} MUTATES`),
      h('span', { class: 'badge gate' }, `${f.gates} GATE`),
      f.warn ? h('span', { class: 'badge warn', title: 'This file says it changes something and names no gate that guards it.' }, 'warning: MUTATES without any GATE') : null,
      when && !Number.isNaN(when.getTime()) ? h('span', {}, `modified ${when.toLocaleString('en-US', SHORT_WHEN)}`) : null);
    if (f.text === undefined) return h('section', { class: 'file' }, sum, h('p', { class: 'hiddenfile', role: 'note' }, hiddenNote(f)));
    const lines = f.text.replace(/\n$/, '').split('\n');
    const pre = h('pre', { class: 'src', tabindex: '0', 'aria-label': `Source of ${f.path.split('/').pop() ?? r.title}` },
      ...lines.map((text, i) => h('span', { class: `ln${f.marks[i + 1] ? ` ${f.marks[i + 1]}` : ''}`, 'data-n': String(i + 1) }, text)));
    return h('section', { class: 'file' }, sum, pre);
  }

  #card(r: ScriptRow, target: string | null): HTMLElement {
    const copy = h('button', { type: 'button', class: 'secondary' }, 'Copy command');
    const msg = h('p', { class: 'msg', role: 'status' }, messages.get(r.id) ?? '');
    copy.addEventListener('click', () => {
      void Promise.resolve(typeof navigator === 'undefined' ? Promise.reject(new Error('no clipboard')) : navigator.clipboard?.writeText(r.command)).then(() => { msg.textContent = 'Copied.'; }, () => { msg.textContent = 'Could not copy. Select the command and copy it.'; });
    });
    const run = r.lastRun ? `Last run ${when(r.lastRun.at)}: ${RESULT[r.lastRun.result] ?? r.lastRun.result}, ${VIA[r.lastRun.via] ?? r.lastRun.via}${r.runs > 1 ? ` (${r.runs} runs)` : ''}.` : r.status === 'history' ? 'Closed without a recorded run.' : 'Not run yet.';
    const actions: HTMLElement[] = [copy];
    if (r.status !== 'history') {
      const mark = h('button', { type: 'button', class: r.status === 'blocked' ? 'primary' : 'secondary' }, r.status === 'blocked' ? 'Mark done (I ran it)' : 'Mark run (I ran it)');
      mark.addEventListener('click', () => {
        mark.disabled = true;
        void (this.#actions ??= createScriptActions()).markRan(r.id).then(async (out) => {
          messages.set(r.id, out.ok ? (out.resolvedAsk ? 'Recorded. The ask is resolved.' : 'Recorded.') : out.message);
          await this.refresh();
        });
      });
      actions.push(mark);
    }
    return h('article', { 'data-id': r.id, ...(target === r.id ? { class: 'target' } : {}) },
      h('div', { class: 'top' }, h('h4', {}, r.title), h('span', { class: 'badge' }, r.kind), r.status === 'blocked' ? h('span', { class: 'badge' }, 'blocked on you') : null),
      h('dl', { class: 'facts' },
        h('dt', {}, 'What it does'), h('dd', {}, r.what),
        h('dt', {}, 'Why we need it'), h('dd', {}, `${r.why} (blocks ${r.blocks})`),
        h('dt', {}, 'After it runs'), h('dd', {}, r.after),
        ...(r.blockedBy ? [h('dt', {}, 'Blocked'), h('dd', {}, r.blockedBy)] : [])),
      h('div', { class: 'code' }, h('pre', { tabindex: '0', 'aria-label': `Command for ${r.title}` }, h('code', {}, r.command))),
      this.#source(r),
      h('p', { class: 'meta' }, `Created ${when(r.createdAt)}. ${run}`),
      r.status === 'blocked' ? h('p', { class: 'meta' }, 'Ask ', h('a', { href: formatFragment(DASHBOARD, 'asks') }, r.ask), ' is in Needs you: review it and press Run there, or copy the command, run it yourself and mark it done.') : null,
      h('div', { class: 'actions' }, ...actions), msg);
  }
}

const SHORT_WHEN: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** What the page says where a file's body is not shown. */
const hiddenNote = (f: SourceRow): string => (f.hidden === 'missing' ? `This file was not found: ${f.path}. It may have been moved or deleted.` : `Not shown: ${f.hidden ?? 'unknown reason'}.`);

const CSS_ESCAPE = (v: string): string => v.replace(/[^A-Za-z0-9_-]/g, '');

customElements.define('script-queue', ScriptQueueElement);

declare global { interface HTMLElementTagNameMap { 'script-queue': ScriptQueueElement } }
