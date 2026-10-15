/**
 * The repost nudge's settings, parsed. Pure: local-config.ts hands in the raw text of each key and gets back the value to use and, when the
 * text was bad, a problem line. A bad value never stops anything: the default is used instead and `logProblem` says so once per key per
 * process, so a typo in the config file shows up in the loop's log instead of silently turning a feature off.
 * An empty or absent value is the default and no problem.
 */

export interface Parsed<T> { value: T; problem?: string }

export const TRIGGERS = ['approval', 'teammate-review'] as const;
export type Trigger = (typeof TRIGGERS)[number];

const ok = <T>(value: T): Parsed<T> => ({ value });
const bad = <T>(value: T, problem: string): Parsed<T> => ({ value, problem });

/** A whole number from `min` to `max`; anything else (a word, a fraction, a sign, out of range) is a problem and gives `fallback`. */
export function parseInt10(raw: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): Parsed<number> {
  const t = raw.trim();
  if (!t) return ok(fallback);
  if (!/^\d{1,9}$/.test(t) || Number(t) < min || Number(t) > max) return bad(fallback, `must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ''}`);
  return ok(Number(t));
}

/** on/true/yes/1 or off/false/no/0, any case. */
export function parseSwitch(raw: string, fallback: boolean): Parsed<boolean> {
  const t = raw.trim().toLowerCase();
  if (!t) return ok(fallback);
  if (/^(on|true|yes|1)$/.test(t)) return ok(true);
  if (/^(off|false|no|0)$/.test(t)) return ok(false);
  return bad(fallback, 'must be on or off');
}

/** `HH:MM`, 24 hour. */
export function parseClock(raw: string, fallback: string): Parsed<string> {
  const t = raw.trim();
  if (!t) return ok(fallback);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? ok(t) : bad(fallback, 'must be HH:MM (24 hour)');
}

/** An IANA zone name; `valid` says whether the runtime knows it. */
export function parseZone(raw: string, fallback: string, valid: (name: string) => boolean): Parsed<string> {
  const t = raw.trim();
  if (!t) return ok(fallback);
  return valid(t) ? ok(t) : bad(fallback, 'must be an IANA time zone such as America/New_York');
}

/** The window's start and end together: an end at or before the start is an empty day, so both fall back. */
export function checkWindow(start: string, end: string, fallback: { start: string; end: string }): Parsed<{ start: string; end: string }> {
  const m = (h: string): number => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  return m(end) > m(start) ? ok({ start, end }) : bad(fallback, `end ${end} must be after start ${start}`);
}

/** A comma list drawn from TRIGGERS. Unknown names are dropped with a problem; nothing left means every trigger. */
export function parseTriggers(raw: string): Parsed<Trigger[]> {
  const all = [...TRIGGERS];
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return ok(all);
  const known = names.filter((n): n is Trigger => (TRIGGERS as readonly string[]).includes(n));
  const unknown = names.filter((n) => !(TRIGGERS as readonly string[]).includes(n));
  const value = [...new Set(known)];
  if (!unknown.length) return ok(value);
  return bad(value.length ? value : all, `unknown trigger ${unknown.join(', ')} (known: ${TRIGGERS.join(', ')})`);
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NAME = /^[A-Za-z0-9_.*-]+$/;

/**
 * `owner`, `owner/name` or `owner/*` entries (a bare owner means `owner/*`). The owner part never holds a `*`, so no entry can match every repo.
 * An entry that is none of those is dropped with a problem. An empty list is the default: the review pool.
 */
export function parseRepos(raw: string): Parsed<string[]> {
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const good: string[] = [];
  const dropped: string[] = [];
  for (const e of entries) {
    const [owner, name, ...rest] = e.split('/');
    if (!owner || !OWNER.test(owner) || rest.length || (name !== undefined && !NAME.test(name))) dropped.push(e);
    else good.push(name === undefined ? `${owner}/*` : e);
  }
  return dropped.length ? bad(good, `dropped ${dropped.join(', ')} (use owner, owner/name or owner/*)`) : ok(good);
}

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Days of the week as a sorted list of day numbers (0 is Sunday): names `mon`, ranges `mon-fri` (a range may wrap, `fri-mon`), `daily`,
 * comma-separated. Any bad entry sends the whole value to the default, since a half-read day list would nudge on the wrong days.
 */
export function parseDays(raw: string, fallback = 'mon-fri'): Parsed<number[]> {
  const read = (text: string): number[] | null => {
    const out = new Set<number>();
    for (const tok of text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (tok === 'daily') { DAY.forEach((_, i) => out.add(i)); continue; }
      const [a, b, ...more] = tok.split('-');
      const from = DAY.indexOf(a ?? '');
      const to = b === undefined ? from : DAY.indexOf(b);
      if (from < 0 || to < 0 || more.length) return null;
      for (let d = from; ; d = (d + 1) % 7) { out.add(d); if (d === to) break; }
    }
    return out.size ? [...out].sort((x, y) => x - y) : null;
  };
  if (!raw.trim()) return ok(read(fallback) ?? []);
  const days = read(raw);
  return days ? ok(days) : bad(read(fallback) ?? [], `must be day names or ranges such as mon-fri or mon,wed-fri, or daily (default ${fallback})`);
}

const logged = new Set<string>();

/** Says once per key per process that a value was bad and what is used instead. The text is the config key and the problem, never a secret. */
export function logProblem(key: string, raw: string, p: Parsed<unknown>, write: (line: string) => void = (l) => console.error(l)): void {
  if (!p.problem || logged.has(key)) return;
  logged.add(key);
  write(`the-maestro: ${key} "${raw.trim().slice(0, 80)}" ignored: ${p.problem}; using ${JSON.stringify(p.value)}`);
}

/** Forgets what was logged, so a test can see a message again. */
export const resetLogged = (): void => logged.clear();
