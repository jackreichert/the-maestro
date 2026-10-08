/**
 * Shapes shared by the event loop, the watch registry, the notifier and the event types. Types only: nothing here
 * exists at runtime, so every import of this file is `import type`.
 */

/** What a command run reports. A caller's `run` returns it instead of throwing on a non-zero exit. */
export interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }

/** Runs a command without a shell. The event loop passes one as `ctx.run` so tests can stub it. */
export type Run = (cmd: string, args: string[]) => RunResult;

/** One `add` line of watches.jsonl. */
export interface Watch {
  op: 'add';
  id: string;
  type: string;
  target: string;
  done_when: string;
  report: string;
  notify_overnight: boolean;
  notify: boolean;
  /** Seconds between checks (--interval), or null for the type's default. */
  interval: number | null;
  /** ISO times. */
  created: string;
  expires: string;
  /** Set at `add` for a standing watch (its type `renews`, no explicit --ttl-hours): the loop keeps pushing `expires` out. */
  renew?: boolean;
}

/** What the loop is given once: how to run commands, its settings and the registry directory. A tick adds `now`, `watch` and `prev` per watch. */
export type LoopContext = Omit<CheckContext, 'now' | 'watch' | 'prev'>;

/** What `check` may read beyond its target. `watch` and `prev` are set per watch; the rest comes from the loop. */
export interface CheckContext {
  run: Run;
  /** Epoch ms of this tick. */
  now: number;
  /** The registry directory. */
  dir?: string;
  config?: { inboxCommand?: string[]; ghLogin?: string; copilotOrgs?: string[]; selfReviewRepos?: string[] };
  watch?: Watch;
  /** The state `check` returned last time, null on the first check. */
  prev?: unknown;
}

/** What a type's `diff` returns for each thing worth reporting. */
export interface WatchEvent { summary: string; actionable?: boolean }

/** A WatchEvent as the loop records it in the digest. */
export interface DigestEvent {
  watch: string;
  type: string;
  at: string;
  summary: string;
  actionable: boolean;
  report: string;
}

/**
 * The module interface of an event type (see event-types/index.ts). Methods are declared with method syntax so
 * a type with its own state shape (`EventType<InboxState>`) is accepted where the loop holds an `EventType`.
 */
export interface EventType<State = unknown> {
  /** Default seconds between checks. */
  interval?: number;
  /** False for a check that never leaves the machine. */
  network?: boolean;
  singleton?: boolean;
  /** True for a standing type: a watch added without --ttl-hours is marked `renew`, and the loop pushes its expiry out by the type's default TTL once less than half is left, instead of retiring it. */
  renews?: boolean;
  slowInQuiet?: boolean;
  /** A minimum interval above the network or local one. */
  floor?: number;
  /** False skips the idle back-off. */
  backoff?: boolean;
  /** 'default' is on unless --no-notify; 'never' overrides the watch; unset is opt-in. */
  notifies?: 'default' | 'never';
  check(target: string, ctx: CheckContext): State;
  /** `prev` is null on the first check: report only what is already worth waking for. */
  diff(prev: State | null, next: State): WatchEvent[] | undefined;
  done?(state: State, watch: Watch): boolean;
  /** Deletes per-watch files when the watch retires or is removed. */
  retired?(watch: Watch, ctx: CheckContext): void;
  /** Throws to refuse a watch at `add`. */
  validate?(target: string, opts: { now: number; ttlMs?: number }): void;
  defaultTtlMs?(target: string, now: number): number;
}

/** What state.json keeps per watch. */
export interface WatchState {
  state?: unknown;
  errors: number;
  checkedAt?: string;
  /** Epoch ms the watch is next due. */
  nextDue?: number;
}

export interface LoopState {
  watches: Record<string, WatchState>;
  /** Epoch ms of each event the cadence reads. */
  events: number[];
}
