import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { createRunApi } from './run-api.ts';
import type { Chunk, Preview, Progress, RunApi, RunSource } from './run-api.ts';

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; margin-block: var(--space-3); }
  .run { display: grid; gap: var(--space-2); max-width: 78ch; }
  .label { font-size: var(--text-xs); color: var(--text-muted); display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: baseline; }
  .badge { border: var(--hairline-strong); border-radius: var(--radius-xs); padding: 0 6px; font-size: var(--text-xs); color: var(--text-secondary); }
  pre { margin: 0; padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 22rem; overflow: auto; }
  pre.out:empty { display: none; }
  .err { color: var(--danger, var(--text-secondary)); }
  .refusals { margin: 0; padding-left: var(--space-4); font-size: var(--text-sm); color: var(--text-secondary); }
  .actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
  .status { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .confirm { font-size: var(--text-sm); display: flex; gap: var(--space-2); align-items: center; }
`;

const POLL_MS = 400;
const secs = (ms: number | null): string => `${((ms ?? 0) / 1000).toFixed(1)}s`;
const END_WORDS: Record<string, string> = { done: 'Finished', failed: 'Could not run', killed: 'Stopped', timeout: 'Timed out' };

/**
 * <run-panel>: review a command and run it on the server. Set `.source` (an ask, or a catalog script and its args) and call `load()`. It shows the exact
 * command the server read and its short hash, every reason it will not run, then Run. Run sends only the source and the hash that was reviewed; the server
 * refuses a command that changed since. Output streams in by polling, with Stop while it runs. A finished run of an ask can answer the ask:
 * the page fires `run-resolved` once the server has recorded the answer.
 */
export class RunPanelElement extends HTMLElement {
  #root: ShadowRoot;
  #source: RunSource | null = null;
  #api: RunApi | null = null;
  #loaded = false;
  #locked = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #runId: string | null = null;
  #gone = false;

  constructor() { super(); this.#root = shadow(this, CSS); }

  set source(v: RunSource | null) { this.#source = v; this.#loaded = false; }
  /** Tests pass a fake; the default talks to the server. */
  set api(v: RunApi) { this.#api = v; }
  /** Sample data: nothing is loaded and nothing can run. */
  set locked(v: boolean) { this.#locked = v; }

  disconnectedCallback(): void { this.#gone = true; if (this.#timer) clearTimeout(this.#timer); }
  connectedCallback(): void { this.#gone = false; }

  get #client(): RunApi { return (this.#api ??= createRunApi()); }

  /** Reads the command from the server and draws it. Safe to call again: it does nothing once loaded. */
  async load(): Promise<void> {
    if (this.#loaded || !this.#source || this.#locked) return;
    this.#loaded = true;
    this.#root.replaceChildren(h('p', { class: 'status', role: 'status' }, 'Reading the command from the server...'));
    const out = await this.#client.preview(this.#source);
    if (out.ok) this.#draw(out.value);
    else { this.#loaded = false; this.#root.replaceChildren(h('p', { class: 'status', role: 'alert' }, out.message)); }
  }

  #draw(p: Preview): void {
    const source = this.#source!;
    const status = h('p', { class: 'status', role: 'status' });
    const out = h('pre', { class: 'out', tabindex: '0', 'aria-label': 'Output' });
    const run = h('button', { type: 'button', class: 'primary' }, 'Run');
    const stop = h('button', { type: 'button', class: 'secondary', hidden: true }, 'Stop');
    const resolve = h('button', { type: 'button', class: 'secondary', hidden: true }, 'Resolve the ask with this result');
    const confirmBox = h('input', { type: 'checkbox', id: 'confirm' });
    const confirm = p.readOnly === false ? h('label', { class: 'confirm' }, confirmBox, 'This can change things. Run it anyway.') : null;
    if (!p.runnable) run.setAttribute('disabled', '');
    const badges = [p.readOnly === true ? 'read-only' : p.readOnly === false ? 'can write' : null, p.tier ? `model: ${p.tier}` : null, `sha256 ${p.sha256.slice(0, 12)}`];
    this.#root.replaceChildren(h('div', { class: 'run' },
      h('div', { class: 'label' }, 'Runs on this computer, in your home folder, exactly as shown:', ...badges.filter((b): b is string => b !== null).map((b) => h('span', { class: 'badge' }, b))),
      h('pre', { class: 'cmd', tabindex: '0', 'aria-label': 'Command' }, p.command),
      p.refusals.length ? h('ul', { class: 'refusals', 'aria-label': 'Why it will not run' }, ...p.refusals.map((r) => h('li', {}, `${r.line ? `Line ${r.line}: ` : ''}${r.message}`))) : null,
      confirm,
      h('div', { class: 'actions' }, run, stop, resolve),
      status, out));

    let since = 0;
    const add = (chunks: Chunk[]): void => {
      for (const c of chunks) out.append(c.stream === 'err' ? h('span', { class: 'err' }, c.text) : c.text);
      since += chunks.length;
      if (chunks.length) out.scrollTop = out.scrollHeight;
    };
    const finish = (pr: Progress): void => {
      stop.hidden = true;
      run.removeAttribute('disabled');
      run.textContent = 'Run again';
      status.textContent = `${END_WORDS[pr.status] ?? 'Ended'}: exit ${pr.exitCode ?? 'none'} in ${secs(pr.durationMs)}.${pr.truncated ? ' Output was cut off.' : ''}`;
      resolve.hidden = source.source !== 'ask';
    };
    const tick = async (): Promise<void> => {
      if (this.#gone || !this.#runId) return;
      const pr = await this.#client.poll(this.#runId, since);
      if (this.#gone) return;
      if (!pr.ok) { status.textContent = pr.message; finish({ status: 'failed', exitCode: null, durationMs: null, chunks: [], next: since, truncated: false }); return; }
      add(pr.value.chunks);
      if (pr.value.status === 'running') this.#timer = setTimeout(() => { void tick(); }, POLL_MS);
      else finish(pr.value);
    };
    run.addEventListener('click', () => { void (async () => {
      if (confirm && !confirmBox.checked) { status.textContent = 'Tick the box to confirm.'; return; }
      run.setAttribute('disabled', '');
      resolve.hidden = true;
      out.replaceChildren(); since = 0;
      status.textContent = 'Starting...';
      const started = await this.#client.start(source, p.sha256, confirmBox.checked);
      if (!started.ok) {
        run.removeAttribute('disabled');
        if (started.error === 'changed' && started.preview) { this.#draw(started.preview); this.#root.querySelector('.status')!.textContent = started.message; return; }
        status.textContent = started.message;
        return;
      }
      this.#runId = started.value;
      stop.hidden = false;
      status.textContent = 'Running...';
      void tick();
    })(); });
    stop.addEventListener('click', () => { if (this.#runId) void this.#client.kill(this.#runId); status.textContent = 'Stopping...'; });
    resolve.addEventListener('click', () => { void (async () => {
      if (!this.#runId) return;
      resolve.setAttribute('disabled', '');
      const res = await this.#client.resolve(this.#runId);
      if (res.ok) {
        status.textContent = 'The ask is answered with this result.';
        this.dispatchEvent(new CustomEvent('run-resolved', { detail: res.value, bubbles: true, composed: true }));
      } else { status.textContent = res.message; resolve.removeAttribute('disabled'); }
    })(); });
  }
}

customElements.define('run-panel', RunPanelElement);

declare global { interface HTMLElementTagNameMap { 'run-panel': RunPanelElement } }
