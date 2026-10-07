/**
 * The decision fields an `ask` can carry: a recommendation, what happens if nobody answers (the default), the door
 * type, a decide-by moment and a class of service. Pure: the CLI hands in the raw flags and the clock.
 *
 * Two rules matter more than the rest, and both are enforced where the row is written and where it is read:
 *   - a missing door is a one-way door;
 *   - a one-way ask can never carry an auto default. `autoDefault` is the only reader a consumer should use to
 *     decide whether silence may act, so a hand-edited row cannot talk its way past the write-time check.
 * Rows written before these fields existed carry none of them and read exactly as before.
 */

export const DOORS = ['one-way', 'two-way'] as const;
export const CLASSES = ['expedite', 'fixed-date', 'standard', 'intangible'] as const;
export type Door = (typeof DOORS)[number];
export type AskClass = (typeof CLASSES)[number];

/** The fields as stored on a row. `by` is YYYY-MM-DD, or a full UTC instant when the ask names a time. */
export interface AskFields { recommend?: string; default?: string; door?: Door; by?: string; class?: AskClass }

/** The part of a row these helpers read; anything may be there, so each field is checked before it is trusted. */
export type AskRow = Partial<Record<'recommend' | 'default' | 'door' | 'by' | 'class', unknown>> & { kind?: string; paste?: unknown };

/** One flag as the command line gave it: whether it was there at all, and its value (null when it had none). */
export interface RawFlag { given: boolean; value: string | null }
export type RawAskFlags = Record<'recommend' | 'default' | 'door' | 'decide-by' | 'class', RawFlag>;

export const TEXT_MAX = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const RELATIVE = /^(\d+)([hdw])$/;
const DAY_MS = 86_400_000;

const isRealDate = (s: string): boolean => {
    if (!DATE.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** A decide-by as written (`2026-10-09`, `2026-10-09T14:00:00Z`, `2d`, `6h`, `1w`), normalised; null when it is none of those. */
export function normaliseBy(raw: string, now: Date): string | null {
    const rel = raw.match(RELATIVE);
    if (rel) {
        const n = Number(rel[1]);
        if (!Number.isSafeInteger(n) || n > 3650) return null;
        if (rel[2] === 'h') return new Date(now.getTime() + n * 3_600_000).toISOString();
        return new Date(now.getTime() + n * (rel[2] === 'w' ? 7 : 1) * DAY_MS).toISOString().slice(0, 10);
    }
    if (isRealDate(raw)) return raw;
    if (INSTANT.test(raw)) { const t = Date.parse(raw); return Number.isNaN(t) ? null : new Date(t).toISOString(); }
    return null;
}

/** Whether a normalised decide-by is already behind `now`: a date is late only once its whole day is over. */
const isPast = (by: string, now: Date): boolean => (DATE.test(by) ? by < now.toISOString().slice(0, 10) : Date.parse(by) <= now.getTime());

/** What the rules look at: the flags as given, the fields they parsed to, and whether this is a paste ask. */
interface Check { flags: RawAskFlags; fields: AskFields; paste: boolean; now: Date }
/** A rule refuses (returns the message) or passes (null). Rules run in order and every refusal is reported. */
interface Rule { name: string; refuse: (c: Check) => string | null }
const given = (c: Check, f: keyof RawAskFlags): boolean => c.flags[f].given;
const value = (c: Check, f: keyof RawAskFlags): string => c.flags[f].value ?? '';

const REFUSALS: Rule[] = [
    { name: 'paste', refuse: (c) => (c.paste && (Object.keys(c.flags) as (keyof RawAskFlags)[]).some((f) => given(c, f)) ? 'A --paste ask is a run-this block, not a decision: it takes no --recommend, --default, --door, --decide-by or --class.' : null) },
    ...(['recommend', 'default'] as const).map((f): Rule => ({
        name: f,
        refuse: (c) => (!given(c, f) ? null : !isText(c.flags[f].value) ? `--${f} needs text.` : value(c, f).trim().length > TEXT_MAX ? `--${f} is over ${TEXT_MAX} characters: say it shorter.` : null),
    })),
    { name: 'door', refuse: (c) => (given(c, 'door') && !(DOORS as readonly string[]).includes(value(c, 'door')) ? `--door must be one-way or two-way, got "${value(c, 'door')}".` : null) },
    { name: 'class', refuse: (c) => (given(c, 'class') && !(CLASSES as readonly string[]).includes(value(c, 'class')) ? `--class must be one of: ${CLASSES.join(', ')}; got "${value(c, 'class')}".` : null) },
    {
        name: 'decide-by',
        refuse: (c) => {
            if (!given(c, 'decide-by')) return null;
            if (!c.fields.by) return `--decide-by must be an ISO date (2026-10-09), an ISO time with a zone (2026-10-09T14:00:00Z) or a relative 6h, 2d or 1w, got "${value(c, 'decide-by')}".`;
            return isPast(c.fields.by, c.now) ? `--decide-by ${c.fields.by} is already past.` : null;
        },
    },
    {
        name: 'default-needs-two-way',
        refuse: (c) => {
            if (!isText(c.fields.default) || c.fields.door === 'two-way') return null;
            return c.fields.door === 'one-way'
                ? 'A one-way ask can never carry a default: silence must not decide it. Drop --default, or make it a --door two-way ask.'
                : 'A --default needs --door two-way. With no --door the ask is treated as one-way, and a one-way ask can never carry a default.';
        },
    },
];

/** A nudge, not a refusal: the ask is written, and the warning names the flag it is missing. */
interface Nudge { name: string; warn: (c: Check) => string | null }
const NUDGES: Nudge[] = [
    { name: 'recommend', warn: (c) => (c.fields.recommend ? null : 'warning: no --recommend. An ask with no recommendation is not ready for the user: say what you would do.') },
    { name: 'door', warn: (c) => (c.fields.door ? null : 'warning: no --door. The ask is treated as one-way, so it can never be defaulted or batch-accepted. Pass --door two-way if it is reversible.') },
];

/** What `ask` does with its flags: the fields to store, the refusals that stop the write, and the warnings that do not. */
export interface AskParse { fields: AskFields; errors: string[]; warnings: string[] }

export function parseAskFields(flags: RawAskFlags, opts: { paste: boolean; now: Date }): AskParse {
    const fields: AskFields = {};
    const text = (f: 'recommend' | 'default'): void => { const v = flags[f].value?.replace(/\s+/g, ' ').trim(); if (v) fields[f] = v; };
    text('recommend');
    text('default');
    const door = flags.door.value;
    if ((DOORS as readonly string[]).includes(door ?? '')) fields.door = door as Door;
    const by = flags['decide-by'].value ? normaliseBy(flags['decide-by'].value, opts.now) : null;
    if (by) fields.by = by;
    // Every new ask carries its class, so the fold exposes it; a missing flag is the default class.
    const cls = flags.class.value;
    fields.class = (CLASSES as readonly string[]).includes(cls ?? '') ? (cls as AskClass) : 'standard';
    const check: Check = { flags, fields, paste: opts.paste, now: opts.now };
    const errors = REFUSALS.map((r) => r.refuse(check)).filter((m): m is string => m !== null);
    const warnings = opts.paste ? [] : NUDGES.map((n) => n.warn(check)).filter((m): m is string => m !== null);
    return { fields: opts.paste ? {} : fields, errors, warnings };
}

// ── reading a row back ──────────────────────────────────────────────────────

/** True when the row carries any of the ask fields; a legacy ask carries none, and is shown and counted as before. */
export const hasAskFields = (r: AskRow): boolean => ['recommend', 'default', 'door', 'by', 'class'].some((k) => r[k as keyof AskRow] !== undefined);

/** The door of an ask. Anything that is not exactly `two-way` (missing, misspelt, hand-edited) is one-way. */
export const askDoor = (r: AskRow): Door => (r.door === 'two-way' ? 'two-way' : 'one-way');

/**
 * What silence may do: the default of a two-way ask, else null. A one-way ask returns null even if its row carries a
 * default, so the door is enforced here at read time and not only when the row is written.
 */
export const autoDefault = (r: AskRow): string | null => (askDoor(r) === 'two-way' && isText(r.default) ? r.default.trim() : null);

export const askClass = (r: AskRow): AskClass => ((CLASSES as readonly string[]).includes(String(r.class)) ? (r.class as AskClass) : 'standard');

/** The decide-by as stored when it is well formed, else undefined. */
export const askBy = (r: AskRow): string | undefined => (typeof r.by === 'string' && (isRealDate(r.by) || INSTANT.test(r.by)) ? r.by : undefined);

/** `2026-10-09` stays as is; an instant reads `2026-10-09 14:00Z`. */
export const byLabel = (by: string): string => (DATE.test(by) ? by : `${by.slice(0, 10)} ${by.slice(11, 16)}Z`);

const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The compact words an ask line adds, in a fixed order: door, decide-by, class (when not standard), recommendation,
 * and what happens if silent. A legacy ask returns none, so its line is unchanged; a one-way ask names no default.
 */
export function askBits(r: AskRow, max = 60): string[] {
    if (!hasAskFields(r)) return [];
    const bits: string[] = [r.door === 'two-way' || r.door === 'one-way' ? r.door : 'door not set: one-way'];
    const by = askBy(r);
    if (by) bits.push(`by ${byLabel(by)}`);
    if (askClass(r) !== 'standard') bits.push(askClass(r));
    if (isText(r.recommend)) bits.push(`rec: ${clipText(r.recommend.replace(/\s+/g, ' ').trim(), max)}`);
    const d = autoDefault(r);
    if (d) bits.push(`if silent: ${clipText(d.replace(/\s+/g, ' ').trim(), max)}`);
    return bits;
}

/** The queue in one phrase for the footer: how many field-bearing asks are one-way and the soonest decide-by; empty when there is nothing to say. */
export function askSummary(rows: AskRow[]): { oneWay: number; nextBy?: string } {
    const withFields = rows.filter(hasAskFields);
    const bys = withFields.map(askBy).filter((b): b is string => b !== undefined).sort();
    return { oneWay: withFields.filter((r) => askDoor(r) === 'one-way').length, ...(bys.length ? { nextBy: bys[0] } : {}) };
}

/** Problems with the fields of one stored row, for `verify`: a hand-edit that the write-time rules would have refused. */
export function askFieldProblems(r: AskRow): string[] {
    const out: string[] = [];
    if (r.door !== undefined && !(DOORS as readonly string[]).includes(String(r.door))) out.push(`door "${String(r.door)}" is not one-way or two-way`);
    if (r.class !== undefined && !(CLASSES as readonly string[]).includes(String(r.class))) out.push(`class "${String(r.class)}" is not one of: ${CLASSES.join(', ')}`);
    if (r.by !== undefined && askBy(r) === undefined) out.push(`by "${String(r.by)}" is not YYYY-MM-DD or an ISO time with a zone`);
    if (r.default !== undefined && askDoor(r) !== 'two-way') out.push('carries a default but is not a two-way door: the default will never fire');
    return out;
}

export const ASK_USAGE = [
    'journal.ts ask "<question>" [--kind question|decision] [--stream S] [--ticket T] --model "<name>" --used "skill:x,tool:y"',
    '    [--recommend "<what you would do>"]   a position the user can accept; without one the ask is not ready (warns)',
    '    [--door one-way|two-way]               two-way = reversible. Missing is treated as one-way',
    '    [--default "<what happens if silent>"] two-way asks only; a one-way ask can never carry one (refused)',
    '    [--decide-by 2026-10-09|2d|6h|1w]      an ISO date, an ISO time with a zone, or relative; not in the past (alias: --by)',
    '    [--class expedite|fixed-date|standard|intangible]   default standard',
    'journal.ts ask "<what to run>" --paste <block-file>      a run-this ask; takes none of the fields above',
];
