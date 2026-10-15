/**
 * The music walkers' brain: which walkers exist, when the next one sets out, and when nothing may move at all.
 * Pure and injectable (no DOM, no real timers), so test/walkers.test.ts drives it with a fake clock.
 */

export type WalkerId = 'note' | 'metronome' | 'baton' | 'cello' | 'clef' | 'drum' | 'keys' | 'record';

export interface Walker { id: WalkerId; /** How long the stroll takes, edge to edge. */ ms: number }
export type Direction = 'ltr' | 'rtl';

/** Each crosses in 10 to 15 s. The page plays the same ms as the travel, so the timer and the animation end together. */
export const WALKERS: readonly Walker[] = [
  { id: 'note', ms: 12_000 },
  { id: 'metronome', ms: 15_000 },
  { id: 'baton', ms: 13_000 },
  { id: 'cello', ms: 14_000 },
  { id: 'clef', ms: 15_000 },
  { id: 'drum', ms: 14_000 },
  { id: 'keys', ms: 15_000 },
  { id: 'record', ms: 10_000 },
];

export const MIN_GAP_MS = 45_000;
export const MAX_GAP_MS = 120_000;
const PREVIEW_GAP_MS = 1_500;

/** The wait before the next walker: 45 to 120 s, jittered. `random` is in [0, 1). */
export function nextGap(random: number): number {
  return Math.round(MIN_GAP_MS + random * (MAX_GAP_MS - MIN_GAP_MS));
}

/** A random walker that is never the one that just crossed. `random` is in [0, 1). */
export function pickWalker(last: WalkerId | null, random: number): Walker {
  const pool = WALKERS.filter((w) => w.id !== last);
  return pool[Math.min(pool.length - 1, Math.floor(random * pool.length))];
}

export function walkerById(id: string | null | undefined): Walker | null {
  return WALKERS.find((w) => w.id === id) ?? null;
}

/** Which page edge the walker comes in from. `random` is in [0, 1). */
export function pickDirection(random: number): Direction {
  return random < 0.5 ? 'ltr' : 'rtl';
}

// The off switch. Stored as '0' when off; anything else, or a browser that refuses storage, means on.
export const STORAGE_KEY = 'podium.walkers';

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function loadEnabled(store: KeyValueStore | null): boolean {
  try { return store?.getItem(STORAGE_KEY) !== '0'; } catch { return true; }
}

export function saveEnabled(store: KeyValueStore | null, on: boolean): void {
  try { store?.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* storage refused (private mode, quota): the switch still works for this page */ }
}

export interface SchedulerEnv {
  random(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** True while the page is in a background tab. */
  hidden(): boolean;
  reducedMotion(): boolean;
  enabled(): boolean;
}

export interface SchedulerHooks {
  play(walker: Walker): void;
  /** The walker ended or was cut short; the stage is empty again. */
  stop(): void;
}

/**
 * Waits a jittered gap, plays one walker, goes idle, repeats. It plays nothing while the tab is hidden, the reader
 * prefers reduced motion, or the walkers are switched off, and holds no timer at all in those states. Call `refresh()`
 * whenever one of those three may have changed.
 */
export class WalkerScheduler {
  readonly #env: SchedulerEnv;
  readonly #hooks: SchedulerHooks;
  readonly #preview: Walker | null;
  #timer: unknown = null;
  #playing: Walker | null = null;
  #last: WalkerId | null = null;

  /** With `preview` (the dev hook) that one walker repeats after a short rest instead of the random schedule. */
  constructor(env: SchedulerEnv, hooks: SchedulerHooks, preview: Walker | null = null) {
    this.#env = env;
    this.#hooks = hooks;
    this.#preview = preview;
  }

  get playing(): WalkerId | null { return this.#playing?.id ?? null; }

  /** May anything play right now? */
  #allowed(): boolean { return this.#env.enabled() && !this.#env.reducedMotion() && !this.#env.hidden(); }

  /** Re-read the conditions: cut a walker short and drop the timer when playing stopped being allowed, start waiting when it became allowed. */
  refresh(): void {
    if (this.#allowed()) { if (this.#timer === null) this.#waitThenPlay(); return; }
    this.#clear();
    if (this.#playing) { this.#playing = null; this.#hooks.stop(); }
  }

  /** The dev preview: play this walker now (if allowed) in place of whatever is waiting or playing. */
  playNow(walker: Walker): void {
    if (!this.#allowed()) return;
    this.#clear();
    this.#start(walker);
  }

  stop(): void {
    this.#clear();
    this.#playing = null;
  }

  #clear(): void {
    if (this.#timer !== null) this.#env.clearTimer(this.#timer);
    this.#timer = null;
  }

  #waitThenPlay(): void {
    this.#timer = this.#env.setTimer(() => {
      this.#timer = null;
      this.#start(this.#preview ?? pickWalker(this.#last, this.#env.random()));
    }, this.#preview ? PREVIEW_GAP_MS : nextGap(this.#env.random()));
  }

  #start(walker: Walker): void {
    this.#playing = walker;
    this.#last = walker.id;
    this.#hooks.play(walker);
    this.#timer = this.#env.setTimer(() => {
      this.#timer = null;
      this.#playing = null;
      this.#hooks.stop();
      this.refresh();
    }, walker.ms);
  }
}
