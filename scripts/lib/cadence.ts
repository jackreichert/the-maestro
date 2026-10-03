/**
 * Adaptive poll cadence for the PR watcher: a pure function, so the event loop can reuse it.
 *
 *   nextInterval({ now, recentEvents, config }) -> { seconds, reason } | { stop: true, reason, until, tz }
 *   (`until` is the local HH:MM quiet hours end, in `tz`)
 *
 *   now           a Date or epoch milliseconds
 *   recentEvents  epoch milliseconds of each thing the watcher saw (a new thread, review or
 *                 comment, a push, a state change)
 *   config        { minInterval, maxInterval, windowMinutes, quietHours, quietMode,
 *                   quietWeekends, tz, watchingSince, pinned }; every field is optional
 *
 * Order of precedence: quiet hours, then a pinned interval, then busy-ness. A pin sets the interval,
 * not whether to run overnight. Busy-ness is read from two tables (ACTIVITY_TIERS by events in the
 * window, IDLE_TIERS by minutes since the newest event, else since `watchingSince`) and the result is
 * clamped to
 * [max(300, minInterval), maxInterval]. Nothing here ever returns less than that floor, a pin
 * included: a pin below it is raised to it.
 */

/** Every cadence setting is optional; nextInterval and watchInterval fill the gaps from DEFAULTS. */
export interface CadenceConfig {
  minInterval?: number;
  maxInterval?: number;
  windowMinutes?: number;
  /** 'HH:MM-HH:MM', or anything else for no quiet hours. */
  quietHours?: string;
  quietMode?: string;
  quietWeekends?: boolean;
  tz?: string;
  /** Epoch ms the watcher started; the idle clock when no event has been seen. */
  watchingSince?: number;
  /** A fixed interval in seconds (--interval). */
  pinned?: number;
  /** event-loop floors, raised above the built-in 120s network and 30s local floors. */
  networkFloor?: number;
  localFloor?: number;
  /** Per-type default intervals in seconds (re-checked by watchInterval, like the type's own). */
  typeIntervals?: Record<string, unknown>;
}

/** CadenceConfig with the fields busyness and the quiet check always read filled in. */
type ResolvedConfig = CadenceConfig & { minInterval: number; maxInterval: number; windowMinutes: number; quietHours: string; quietMode: string; quietWeekends: boolean };

/** What a type module declares about its own schedule (see event-types/index.ts). */
/** `interval` is unknown on purpose: an overlay type is plain JS and may declare anything; watchInterval skips what is not a positive number. */
export interface WatchSpec { interval?: unknown; network?: boolean; backoff?: boolean; floor?: number }

export interface Interval { seconds: number; reason: string }
export interface Stop { stop: true; reason: string; until: string; tz: string }
interface Limits { floor: number; ceiling: number }
/** Epoch milliseconds or a Date. */
type Instant = number | Date;

export const FLOOR_SECONDS = 300;

// Per-watch scheduling for the event loop. A type is "network" unless it declares `network = false`,
// so a type that says nothing gets the GitHub-safe floor.
export const NETWORK_FLOOR = 120;
export const LOCAL_FLOOR = 30;
export const DEFAULT_WATCH_INTERVAL = 180;
/** Poll pace of a `slowInQuiet` type during quiet hours when quiet_hours_mode is `slow`. */
export const SLOW_QUIET_SECONDS = 1800;
// "Steady" back-off tier in seconds: the idle tiers stretch a watch's interval by tier / this, never shrink it.
const BACKOFF_BASE = 600;

export const DEFAULTS: ResolvedConfig = {
  minInterval: FLOOR_SECONDS,
  maxInterval: 1800,
  windowMinutes: 30,
  quietHours: '20:00-07:00',
  quietMode: 'stop',
  quietWeekends: false,
  tz: undefined,
};

// Events inside the window, most active first. `seconds: null` means "use minInterval".
export const ACTIVITY_TIERS = [
  { minEvents: 3, seconds: null, label: 'high activity' },
  { minEvents: 1, seconds: 600, label: 'some activity' },
];

// Minutes since the newest event (or since the watcher started, with none), longest quiet first.
export const IDLE_TIERS = [
  { idleMinutes: 120, seconds: 1800, label: 'quiet for 2h+' },
  { idleMinutes: 60, seconds: 900, label: 'quiet for 1h+' },
  { idleMinutes: 0, seconds: 600, label: 'steady' },
];

// What each quiet_hours_mode does when the clock says nobody is reviewing.
const QUIET_MODES: Record<string, (limits: Limits, resume: { until: string; tz: string }) => Interval | Stop> = {
  stop: (_limits, resume) => ({ stop: true, reason: 'quiet hours', ...resume }),
  slow: (limits) => ({ seconds: clamp(SLOW_QUIET_SECONDS, limits), reason: 'quiet hours (slow)' }),
};

const WEEKEND = new Set(['Sat', 'Sun']);

/** DEFAULTS under the config, skipping fields the config leaves undefined. */
const resolve = (config: CadenceConfig): ResolvedConfig => ({ ...DEFAULTS, ...definedOnly(config) });
const definedOnly = (config: CadenceConfig): CadenceConfig => Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));

/** The slowest-allowed floor in seconds: 300, or watch_min_interval when that is higher. */
export const floorSeconds = (config: CadenceConfig = {}): number => Math.max(FLOOR_SECONDS, config.minInterval ?? 0);

const clamp = (seconds: number, { floor, ceiling }: Limits): number => Math.min(ceiling, Math.max(floor, seconds));

/** '20:00-07:00' -> { start, end } in minutes after midnight; anything else (off, none, junk) -> null. */
export function parseQuietHours(text: unknown): { start: number; end: number } | null {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [sh, sm, eh, em] = m.slice(1).map(Number) as [number, number, number, number];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

/** Local clock reading in `tz` (the system zone when undefined): minutes after midnight and weekday. */
export function localClock(now: Instant, tz: string | undefined): { minutes: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(new Date(now));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: get('weekday') };
}

// A window that crosses midnight (start > end) is quiet on either side of it.
const inWindow = (minutes: number, { start, end }: { start: number; end: number }): boolean => (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end);

function isQuiet(now: Instant, config: ResolvedConfig): boolean {
  const { minutes, weekday } = localClock(now, config.tz);
  const window = parseQuietHours(config.quietHours);
  return (window !== null && inWindow(minutes, window)) || (config.quietWeekends === true && WEEKEND.has(weekday));
}

function pinned(seconds: number, floor: number): Interval {
  if (seconds >= floor) return { seconds, reason: 'pinned by --interval' };
  return { seconds: floor, reason: `pinned by --interval (raised to ${floor})` };
}

const HH_MM = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const MAX_QUIET_MINUTES = 3 * 24 * 60;

/** When quiet hours end: { until: 'HH:MM', tz } in the config zone, scanning minute by minute (a weekend can span days). */
function resumeAt(now: number, config: ResolvedConfig): { until: string; tz: string } {
  let minute = 1;
  while (minute < MAX_QUIET_MINUTES && isQuiet(now + minute * 60000, config)) minute++;
  const tz = config.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { until: HH_MM(localClock(now + minute * 60000, config.tz).minutes), tz };
}

function busyness(now: number, recentEvents: number[], config: ResolvedConfig): Interval {
  const windowMs = config.windowMinutes * 60000;
  const inside = recentEvents.filter((t) => t <= now && now - t <= windowMs).length;
  const active = ACTIVITY_TIERS.find((tier) => inside >= tier.minEvents);
  if (active) return { seconds: active.seconds ?? config.minInterval, reason: `${active.label}: ${inside} event(s) in ${config.windowMinutes}m` };
  // Idleness runs from the newest event, which the state file carries across restarts. Only with
  // no event at all is there nothing to measure from but the watcher's own start.
  const past = recentEvents.filter((t) => t <= now);
  const marks = past.length ? past : [config.watchingSince].filter((t): t is number => t !== undefined);
  const last = marks.length ? Math.max(...marks) : now;
  const idle = (now - last) / 60000;
  const tier = IDLE_TIERS.find((t) => idle >= t.idleMinutes) ?? IDLE_TIERS[IDLE_TIERS.length - 1]!;
  return { seconds: tier.seconds, reason: tier.label };
}

export function nextInterval({ now, recentEvents = [], config = {} }: { now: Instant; recentEvents?: number[]; config?: CadenceConfig }): Interval | Stop {
  const cfg = resolve(config);
  const at = new Date(now).getTime();
  const floor = floorSeconds(cfg);
  const limits = { floor, ceiling: Math.max(floor, cfg.maxInterval) };
  if (isQuiet(at, cfg)) return (QUIET_MODES[cfg.quietMode] ?? QUIET_MODES.stop)(limits, resumeAt(at, cfg));
  if (cfg.pinned) return pinned(cfg.pinned, floor);
  const { seconds, reason } = busyness(at, recentEvents, { ...cfg, minInterval: floor });
  return { seconds: clamp(seconds, limits), reason };
}

/**
 * The lowest interval a watch may run at: 120s for network types (config may raise it, never lower it), 30s for local ones.
 * A type may declare a higher `floor` of its own (pr-watch: 300s, because polling PRs faster costs more wake-ups than it saves);
 * config.minInterval (watch_min_interval) can raise that type floor further, and never touches types without one.
 */
export const watchFloor = (spec: WatchSpec = {}, config: CadenceConfig = {}): number => Math.max(
  spec.floor !== undefined && Number.isFinite(spec.floor) ? Math.max(spec.floor, config.minInterval ?? 0) : 0,
  spec.network === false ? Math.max(LOCAL_FLOOR, config.localFloor ?? 0) : Math.max(NETWORK_FLOOR, config.networkFloor ?? 0),
);

/**
 * Seconds until one watch is due again, for the event loop.
 *   spec      { interval, network, backoff } as the watch's type declares them
 *   override  the watch's own --interval (or a loop-wide pin), else config.typeIntervals[type], else the type's default
 * Idle periods stretch the interval by the same back-off tiers as nextInterval (unless the type sets backoff = false),
 * capped at config.maxInterval but never below the declared interval. The floor is applied last, so no setting,
 * override or back-off result can go under it.
 */
export function watchInterval({ type, spec = {}, override, now, recentEvents = [], config = {} }: {
  type?: string; spec?: WatchSpec; override?: unknown; now: Instant; recentEvents?: number[]; config?: CadenceConfig;
}): Interval {
  const floor = watchFloor(spec, config);
  // An interval that is not a finite positive number (an overlay typo, Infinity, NaN) is skipped for the next source, not trusted.
  const usable = (n: unknown): boolean => Number.isFinite(Number(n)) && Number(n) > 0;
  const pick = [override, type === undefined ? undefined : config.typeIntervals?.[type], spec.interval].find(usable);
  const base = pick === undefined ? DEFAULT_WATCH_INTERVAL : Number(pick);
  let seconds = base;
  let reason = 'steady';
  if (spec.backoff !== false) {
    const cfg: ResolvedConfig = { ...resolve(config), minInterval: 0 };
    const busy = busyness(new Date(now).getTime(), recentEvents, cfg);
    const factor = Math.max(1, busy.seconds / BACKOFF_BASE);
    seconds = Math.min(base * factor, Math.max(base, cfg.maxInterval));
    reason = busy.reason;
  }
  seconds = Number.isFinite(seconds) ? Math.max(floor, Math.ceil(seconds)) : floor;
  return { seconds, reason: base < floor ? `${reason} (raised to the ${floor}s floor)` : reason };
}
