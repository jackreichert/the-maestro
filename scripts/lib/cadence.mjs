/**
 * Adaptive poll cadence for the PR watcher: a pure function, so the event loop can reuse it.
 *
 *   nextInterval({ now, recentEvents, config }) -> { seconds, reason } | { stop: true, reason }
 *
 *   now           a Date or epoch milliseconds
 *   recentEvents  epoch milliseconds of each thing the watcher saw (a new thread, review or
 *                 comment, a push, a state change)
 *   config        { minInterval, maxInterval, windowMinutes, quietHours, quietMode,
 *                   quietWeekends, tz, watchingSince, pinned }; every field is optional
 *
 * Order of precedence: a pinned interval, then quiet hours, then busy-ness. Busy-ness is read from
 * two tables (ACTIVITY_TIERS by events in the window, IDLE_TIERS by minutes since the last event)
 * and the result is clamped to [max(300, minInterval), maxInterval]. Nothing here ever returns
 * less than 300 seconds unless the caller pins it.
 */

export const FLOOR_SECONDS = 300;

export const DEFAULTS = {
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

// Minutes since the last event (or since the watcher started), longest quiet first.
export const IDLE_TIERS = [
  { idleMinutes: 120, seconds: 1800, label: 'quiet for 2h+' },
  { idleMinutes: 60, seconds: 900, label: 'quiet for 1h+' },
  { idleMinutes: 0, seconds: 600, label: 'steady' },
];

// What each quiet_hours_mode does when the clock says nobody is reviewing.
const QUIET_MODES = {
  stop: () => ({ stop: true, reason: 'quiet hours' }),
  slow: (limits) => ({ seconds: clamp(1800, limits), reason: 'quiet hours (slow)' }),
};

const WEEKEND = new Set(['Sat', 'Sun']);

const clamp = (seconds, { floor, ceiling }) => Math.min(ceiling, Math.max(floor, seconds));

/** '20:00-07:00' -> { start, end } in minutes after midnight; anything else (off, none, junk) -> null. */
export function parseQuietHours(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

/** Local clock reading in `tz` (the system zone when undefined): minutes after midnight and weekday. */
export function localClock(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: get('weekday') };
}

// A window that crosses midnight (start > end) is quiet on either side of it.
const inWindow = (minutes, { start, end }) => (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end);

function isQuiet(now, config) {
  const { minutes, weekday } = localClock(now, config.tz);
  const window = parseQuietHours(config.quietHours);
  return (window !== null && inWindow(minutes, window)) || (config.quietWeekends && WEEKEND.has(weekday));
}

function busyness(now, recentEvents, config) {
  const windowMs = config.windowMinutes * 60000;
  const inside = recentEvents.filter((t) => t <= now && now - t <= windowMs).length;
  const active = ACTIVITY_TIERS.find((tier) => inside >= tier.minEvents);
  if (active) return { seconds: active.seconds ?? config.minInterval, reason: `${active.label}: ${inside} event(s) in ${config.windowMinutes}m` };
  // With no event and no start time to measure from, there is nothing to call idle yet.
  const marks = [...recentEvents.filter((t) => t <= now), config.watchingSince].filter((t) => t !== undefined);
  const last = marks.length ? Math.max(...marks) : now;
  const idle = (now - last) / 60000;
  const tier = IDLE_TIERS.find((t) => idle >= t.idleMinutes);
  return { seconds: tier.seconds, reason: tier.label };
}

export function nextInterval({ now, recentEvents = [], config = {} }) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) };
  const at = new Date(now).getTime();
  if (cfg.pinned) return { seconds: cfg.pinned, reason: 'pinned by --interval' };
  const floor = Math.max(FLOOR_SECONDS, cfg.minInterval);
  const limits = { floor, ceiling: Math.max(floor, cfg.maxInterval) };
  if (isQuiet(at, cfg)) return (QUIET_MODES[cfg.quietMode] ?? QUIET_MODES.stop)(limits);
  const { seconds, reason } = busyness(at, recentEvents, { ...cfg, minInterval: floor });
  return { seconds: clamp(seconds, limits), reason };
}
