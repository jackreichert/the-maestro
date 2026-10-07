/**
 * Live updates for the page, with no DOM in it so the fallback logic can be tested under node.
 *
 * Normally the server pushes a `changed` event over Server-Sent Events and the page reloads its data. When the stream is
 * unavailable (no EventSource, or the connection errors) it polls every 30 s instead and goes back to the stream once that
 * reconnects. A response is applied only if it is the newest request's and its `seq` differs from what is already shown,
 * so a slow answer can never overwrite a newer one and an unchanged board is not redrawn (a redraw would drop a half-typed answer).
 */

export type LiveStatus = 'live' | 'polling' | 'offline';

export const POLL_MS = 30_000;
const STREAM_CLOSED = 2;   // EventSource.CLOSED

/** The slice of EventSource this uses. */
export interface StreamLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  /** EventSource's: 2 once the browser has given up (a non-stream answer such as 403 or 500) and will not retry. */
  readonly readyState?: number;
  addEventListener(type: 'changed', listener: () => void): void;
  close(): void;
}

export interface LiveDeps<T> {
  /** Open the event stream, or null when the browser has none. */
  open(): StreamLike | null;
  /** The current data, or null when no server answered. */
  load(): Promise<T | null>;
  seqOf(data: T): string;
  apply(data: T): void;
  onStatus(status: LiveStatus): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export class LiveUpdates<T> {
  readonly #d: LiveDeps<T>;
  #stream: StreamLike | null = null;
  #timer: unknown = null;
  #loop = 0;   // the polling loop that may still schedule; stopping bumps it, so a loop left in flight ends instead of restarting
  #streaming = false;   // the stream is open right now
  #stopped = true;
  #request = 0;
  #shown: string;
  #status: LiveStatus | null = null;

  /** `shownSeq` is the seq of the data the page already holds. */
  constructor(deps: LiveDeps<T>, shownSeq: string) {
    this.#d = deps;
    this.#shown = shownSeq;
  }

  get status(): LiveStatus | null { return this.#status; }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attach();
  }

  /** Open the stream and wire it; without one (no EventSource) the page just polls. */
  #attach(): void {
    const stream = this.#d.open();
    if (!stream) { this.#poll(); return; }
    this.#stream = stream;
    stream.addEventListener('changed', () => { void this.refresh(); });
    stream.onopen = () => {
      this.#streaming = true;
      this.#stopPolling();
      this.#set('live');
      void this.refresh();   // anything that changed while the stream was down
    };
    stream.onerror = () => {
      this.#streaming = false;
      this.#poll();   // the browser keeps retrying the stream by itself; poll until it is back
    };
  }

  stop(): void {
    this.#stopped = true;
    this.#request += 1;   // an answer still in flight is stale now
    this.#stopPolling();
    this.#stream?.close();
    this.#stream = null;
    this.#streaming = false;
  }

  /** Fetch and apply the newest data unless a newer fetch has started or nothing changed. */
  async refresh(): Promise<void> {
    const mine = ++this.#request;
    let data: T | null = null;
    try { data = await this.#d.load(); } catch { data = null; }
    if (mine !== this.#request || this.#stopped) return;
    if (data === null) { this.#set('offline'); return; }
    this.#set(this.#streaming ? 'live' : 'polling');
    // The browser stops retrying after a non-stream answer; the server answered this poll, so try the stream again.
    if (!this.#streaming && this.#stream?.readyState === STREAM_CLOSED) { this.#stream.close(); this.#attach(); }
    const seq = this.#d.seqOf(data);
    if (seq === this.#shown) return;
    this.#shown = seq;
    this.#d.apply(data);
  }

  #poll(): void {
    if (this.#status !== 'offline') this.#set('polling');   // offline stays until a poll succeeds; the browser's retry error is not news
    if (this.#timer !== null || this.#stopped) return;
    const mine = ++this.#loop;
    const tick = (): void => {
      this.#timer = this.#d.setTimer(() => {
        if (mine !== this.#loop) return;
        void this.refresh().then(() => { if (mine === this.#loop) tick(); });
      }, POLL_MS);
    };
    tick();
    void this.refresh();
  }

  #stopPolling(): void {
    this.#loop += 1;   // invalidates the running loop, including a poll whose fetch is still in flight
    if (this.#timer !== null) this.#d.clearTimer(this.#timer);
    this.#timer = null;
  }

  #set(status: LiveStatus): void {
    if (status === this.#status || this.#stopped) return;
    this.#status = status;
    this.#d.onStatus(status);
  }
}

/** The indicator's words. Words, not colour alone, say which mode the page is in. */
export function liveLabel(status: LiveStatus | null): string {
  switch (status) {
    case 'live': return 'Updates live';
    case 'polling': return 'Checking every 30 s';
    case 'offline': return 'Offline, retrying';
    case null: return '';
  }
}
