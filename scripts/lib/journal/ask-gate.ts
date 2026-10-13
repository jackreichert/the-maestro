/**
 * The gate in front of `ask`: before a question reaches the user it must say where it was looked for.
 *
 * 1. Searched first. `--searched "<where I looked>"` is required, so "check the code and docs before asking" is enforced
 *    where the row is written and not only described in a memory file. The text is stored on the row as `searched`.
 * 2. The door routes. A two-way ask with a `--default` is acted on and logged, not queued for the user, unless it is
 *    `--outward` (anything another person sees), which always asks. `routeAsk` decides, through `autoDefault`, the same
 *    reader every consumer uses, so a hand-edited row cannot talk its way past it.
 *
 * Pure: the CLI hands in the raw flags and the parsed fields.
 */

import { CONTROL, TEXT_MAX, autoDefault, isText } from './ask-fields.ts';
import type { AskFields, RawFlag } from './ask-fields.ts';

/** The gate's fields as stored on a row. */
export interface AskGate { searched?: string; outward?: true }

/** What the rules look at: the raw --searched flag. */
export interface RawGateFlags { searched: RawFlag; outward: boolean }
/** A rule refuses (returns the message) or passes (null). Rules run in order and every refusal is reported. */
interface GateRule { name: string; refuse: (c: RawGateFlags) => string | null }

const SEARCHED_WHY = 'name the docs, code, library page or ledger rows you checked, so a question that could have been answered is caught before it reaches the user';

const GATE_RULES: GateRule[] = [
    { name: 'searched-given', refuse: (c) => (isText(c.searched.value) ? null : `ask needs --searched "<where I looked>": ${SEARCHED_WHY}.`) },
    {
        name: 'searched-text',
        refuse: (c) => {
            const v = c.searched.value ?? '';
            if (!isText(v)) return null;   // the rule above already refused
            return CONTROL.test(v) ? '--searched has a control character: plain text only.' : v.trim().length > TEXT_MAX ? `--searched is over ${TEXT_MAX} characters: say it shorter.` : null;
        },
    },
];

export interface GateParse { gate: AskGate; errors: string[] }

/** The gate fields to store, and the refusals that stop the write. */
export function parseAskGate(flags: RawGateFlags): GateParse {
    const errors = GATE_RULES.map((r) => r.refuse(flags)).filter((m): m is string => m !== null);
    const searched = flags.searched.value?.replace(/\s+/g, ' ').trim();
    return { gate: errors.length ? {} : { ...(searched ? { searched } : {}), ...(flags.outward ? { outward: true as const } : {}) }, errors };
}

/** A nudge, not a refusal: an `--outward` ask is written, and the warning says its default will not fire. */
export const gateWarnings = (fields: AskFields, gate: AskGate): string[] => (gate.outward && fields.default ? ['warning: --outward asks always ask, so the --default will never be acted on.'] : []);

/** How an ask is routed: acted on its default and logged (`acted` holds the default), or put to the user. */
export type Routed = { acted: string; row: { kind: 'note'; text: string; actedOn: string } } | { acted: null };

/**
 * A two-way ask with a default and no `--outward` is acted on: the row is a plain `note` that records the question and
 * the default taken, so it never reaches the board. Everything else asks. The decision is `autoDefault`'s.
 */
export function routeAsk(question: string, fields: AskFields, gate: AskGate): Routed {
    const acted = autoDefault({ door: fields.door, default: fields.default, outward: gate.outward });
    return acted === null ? { acted: null } : { acted, row: { kind: 'note', text: `acted on default: ${acted} (asked: ${question})`, actedOn: acted } };
}
