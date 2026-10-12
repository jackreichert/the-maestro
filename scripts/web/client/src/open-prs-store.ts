/**
 * The Open PRs tab's state, outside any element: the app redraws the whole page on every live update, so the loaded table and a
 * refresh in flight must survive it. One store per page. Dependencies are injected so node:test runs it with no browser or server.
 */
import type { OpenPrsData, PrsRefreshStatus } from './types.ts';

/** What the Refresh button shows. `running` is the only state that blocks another press. */
export interface RefreshView { kind: 'idle' | 'running' | 'done' | 'failed' | 'locked'; message?: string }
export interface OpenPrsModel { data: OpenPrsData | null; loaded: boolean; refresh: RefreshView }
export interface OpenPrsDeps {
  load(): Promise<OpenPrsData | null>;
  status(): Promise<PrsRefreshStatus | null>;
  /** POST the refresh; the HTTP status of the answer, or null when the request could not be made (no edit token, offline). */
  post(): Promise<number | null>;
  delay(ms: number): Promise<void>;
  pollMs?: number;
  /** Give up waiting after this many status reads (the server's own rebuild limit is 180 s). */
  maxPolls?: number;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_POLLS = 100;
const SLOW = 'The refresh is taking longer than expected. The table shows the last data; press Refresh again later.';

export class OpenPrsStore {
  readonly #deps: OpenPrsDeps;
  readonly #listeners = new Set<() => void>();
  #model: OpenPrsModel = { data: null, loaded: false, refresh: { kind: 'idle' } };
  #pressing = false;

  constructor(deps: OpenPrsDeps) { this.#deps = deps; }

  get model(): OpenPrsModel { return this.#model; }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /** Read the table. A failed read keeps the data already shown. */
  async load(): Promise<void> {
    const data = await this.#deps.load();
    this.#set({ data: data ?? this.#model.data, loaded: true });
  }

  /** The Refresh press. A press while one is in flight does nothing, so a double click makes one request. */
  async refresh(): Promise<void> {
    if (this.#pressing) return;
    this.#pressing = true;
    try {
      this.#set({ refresh: { kind: 'running' } });
      const final = await this.#run();
      if (final.kind === 'done' || final.kind === 'failed' || final.kind === 'locked') await this.load();
      this.#set({ refresh: final });
    } finally {
      this.#pressing = false;
    }
  }

  async #run(): Promise<RefreshView> {
    let http: number | null;
    try { http = await this.#deps.post(); } catch { http = null; }
    if (http === null) return { kind: 'failed', message: 'The refresh could not be requested. Reload the page and try again.' };
    if (http !== 202 && http !== 409) return { kind: 'failed', message: 'The server refused the refresh.' };
    const every = this.#deps.pollMs ?? DEFAULT_POLL_MS;
    for (let i = 0; i < (this.#deps.maxPolls ?? DEFAULT_MAX_POLLS); i += 1) {
      await this.#deps.delay(every);
      let st: PrsRefreshStatus | null;
      try { st = await this.#deps.status(); } catch { st = null; }
      if (st === null) return { kind: 'failed', message: 'The refresh status could not be read.' };
      if (st.state === 'running') continue;
      if (st.state === 'failed') return { kind: 'failed', message: st.message ?? 'The refresh failed.' };
      if (st.state === 'locked') return { kind: 'locked', message: st.message ?? 'Another refresh is already running. Try again in a minute.' };
      return { kind: 'done' };
    }
    return { kind: 'failed', message: SLOW };
  }

  #set(patch: Partial<OpenPrsModel>): void {
    this.#model = { ...this.#model, ...patch };
    for (const fn of this.#listeners) fn();
  }
}
