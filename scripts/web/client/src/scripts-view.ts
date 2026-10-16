import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { createRunApi } from './run-api.ts';
import type { ArgSpec, CatalogView, RunApi, RunSource, ScriptInfo } from './run-api.ts';
import './run-panel.ts';
import './script-queue.ts';

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; }
  section.group { margin-block: var(--space-5); }
  h3.group-name { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin: 0 0 var(--space-2); }
  article { border-bottom: 1px solid var(--border); padding-block: var(--space-4); }
  .head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; }
  .head h4 { margin: 0; font-size: var(--text-md); }
  .badge { border: var(--hairline-strong); border-radius: var(--radius-xs); padding: 0 6px; font-size: var(--text-xs); color: var(--text-secondary); }
  .desc { margin: var(--space-1) 0 var(--space-2); color: var(--text-secondary); max-width: 70ch; }
  .args { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-block: var(--space-2); }
  .args label { display: grid; gap: 2px; font-size: var(--text-xs); color: var(--text-muted); }
  .args label.check { display: flex; gap: var(--space-2); align-items: center; }
  .args input[type=text], .args input[type=number], .args select { font: inherit; padding: 4px 8px; border: var(--hairline-strong); border-radius: var(--radius-xs); background: var(--surface-1); color: var(--text-primary); }
  .problems { color: var(--text-secondary); font-size: var(--text-sm); }
  h3.catalog-title { font-size: var(--text-lg); margin: var(--space-6) 0 var(--space-2); }
  .note { color: var(--text-secondary); max-width: 70ch; }
`;

type Values = Record<string, string | number | boolean>;
/** What the reader had typed and which scripts they had open: kept for the page's life, because a live update rebuilds the tab. */
const drafts = new Map<string, Values>();
const opened = new Set<string>();
/** Forget the drafts (tests). */
export const clearScriptDrafts = (): void => { drafts.clear(); opened.clear(); };

/** The args as the server takes them: blanks are left out (the schema's default applies), numbers are numbers. */
export function argsOf(spec: ArgSpec[], raw: Values): Values {
  const out: Values = {};
  for (const a of spec) {
    const v = raw[a.name];
    if (v === undefined || v === '' || v === false) continue;
    if (a.type === 'integer') { const n = Number(v); if (Number.isFinite(n)) out[a.name] = n; } else out[a.name] = v;
  }
  return out;
}

/**
 * <scripts-view>: the catalog of scripts the Podium can run, grouped, with what each does, whether it is read-only and which model tier it suits.
 * Review shows the exact command the server built (run-panel.ts); changing an argument asks for a fresh review, because the hash covers the arguments.
 */
export class ScriptsViewElement extends HTMLElement {
  #root: ShadowRoot;
  #api: RunApi | null = null;
  #catalog: CatalogView | null = null;
  #error = '';

  constructor() { super(); this.#root = shadow(this, CSS); }

  /** Tests pass a fake; the default talks to the server. */
  set api(v: RunApi) { this.#api = v; }

  connectedCallback(): void { void this.#load(); }

  async #load(): Promise<void> {
    this.#root.replaceChildren(h('p', { class: 'note', role: 'status' }, 'Loading the script catalog...'));
    const out = await (this.#api ??= createRunApi()).catalog();
    if (out.ok) { this.#catalog = out.value; this.#error = ''; } else this.#error = out.message;
    this.#render();
  }

  #render(): void {
    if (!this.#catalog) { this.#root.replaceChildren(h('script-queue', {}), h('p', { class: 'note', role: 'alert' }, this.#error || 'The catalog could not be loaded.')); return; }
    const { scripts, problems } = this.#catalog;
    const groups = [...new Set(scripts.map((s) => s.group))];
    this.#root.replaceChildren(
      h('script-queue', {}),
      h('h3', { class: 'catalog-title' }, 'Podium catalog'),
      h('p', { class: 'note' }, 'Scripts the Podium may run on this computer. Review shows the exact command; nothing runs until you press Run. Arguments are checked against each script\'s schema and are never passed through a shell.'),
      ...groups.map((g) => h('section', { class: 'group', 'aria-label': g }, h('h3', { class: 'group-name' }, g), ...scripts.filter((s) => s.group === g).map((s) => this.#card(s)))),
      ...(scripts.length === 0 ? [h('p', { class: 'note' }, 'The catalog has no scripts.')] : []),
      ...(problems.length ? [h('ul', { class: 'problems', 'aria-label': 'Entries that did not load' }, ...problems.map((p) => h('li', {}, `Not loaded: ${p}`)))] : []));
  }

  #card(s: ScriptInfo): HTMLElement {
    const values: Values = drafts.get(s.id) ?? {};
    drafts.set(s.id, values);
    const slot = h('div', { class: 'slot' });
    const review = h('button', { type: 'button', class: 'secondary', 'aria-expanded': 'false' }, 'Review');
    const show = (on: boolean): void => {
      slot.replaceChildren();
      review.setAttribute('aria-expanded', String(on));
      review.textContent = on ? 'Hide' : 'Review';
      if (on) opened.add(s.id); else opened.delete(s.id);
      if (!on) return;
      const panel = document.createElement('run-panel');
      const source: RunSource = { source: 'script', name: s.id, args: argsOf(s.args, values) };
      if (this.#api) panel.api = this.#api;
      panel.source = source;
      slot.append(panel);
      void panel.load();
    };
    const fields = s.args.map((a) => this.#field(s.id, a, values, () => { if (opened.has(s.id)) show(true); }));
    review.addEventListener('click', () => show(!opened.has(s.id)));
    const card = h('article', {},
      h('div', { class: 'head' }, h('h4', {}, s.name),
        h('span', { class: 'badge' }, s.readOnly ? 'read-only' : 'can write'),
        s.tier !== 'none' ? h('span', { class: 'badge' }, `model: ${s.tier}`) : null,
        h('span', { class: 'badge' }, `${s.timeoutSeconds}s limit`)),
      h('p', { class: 'desc' }, s.description),
      fields.length ? h('div', { class: 'args' }, ...fields) : null,
      h('div', { class: 'actions' }, review), slot);
    if (opened.has(s.id)) show(true);
    return card;
  }

  #field(id: string, a: ArgSpec, values: Values, changed: () => void): HTMLElement {
    const fid = `${id}-${a.name}`;
    const label = a.description ? `${a.name} (${a.description})` : a.name;
    if (a.type === 'boolean') {
      const box = h('input', { type: 'checkbox', id: fid });
      box.checked = values[a.name] === true;
      box.addEventListener('change', () => { values[a.name] = box.checked; changed(); });
      return h('label', { class: 'check', for: fid }, box, label);
    }
    if (a.type === 'enum') {
      const sel = h('select', { id: fid }, h('option', { value: '' }, a.default !== undefined ? `default (${a.default})` : 'choose'), ...(a.values ?? []).map((v) => h('option', { value: v }, v)));
      sel.value = String(values[a.name] ?? '');
      sel.addEventListener('change', () => { values[a.name] = sel.value; changed(); });
      return h('label', { for: fid }, label, sel);
    }
    const input = h('input', { type: a.type === 'integer' ? 'number' : 'text', id: fid, ...(a.type === 'integer' ? { min: String(a.min), max: String(a.max) } : { maxlength: '80', autocomplete: 'off', spellcheck: 'false' }), ...(a.default !== undefined ? { placeholder: String(a.default) } : {}) });
    input.value = String(values[a.name] ?? '');
    input.addEventListener('change', () => { values[a.name] = input.value; changed(); });
    return h('label', { for: fid }, label, input);
  }
}

customElements.define('scripts-view', ScriptsViewElement);

declare global { interface HTMLElementTagNameMap { 'scripts-view': ScriptsViewElement } }
