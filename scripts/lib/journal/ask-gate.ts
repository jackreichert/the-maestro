/**
 * The gate in front of `ask`: before a question reaches the user it must say where it was looked for.
 *
 * `--searched "<where I looked>"` is required, so "check the code and docs before asking" is enforced where the row is
 * written and not only described in a memory file. Pure: the CLI hands in the raw flag. The text is stored on the row
 * as `searched`, so a reviewer can see what was checked.
 */

import { CONTROL, TEXT_MAX, isText } from './ask-fields.ts';
import type { RawFlag } from './ask-fields.ts';

/** The gate's fields as stored on a row. */
export interface AskGate { searched?: string }

/** What the rules look at: the raw --searched flag. */
interface GateCheck { searched: RawFlag }
/** A rule refuses (returns the message) or passes (null). Rules run in order and every refusal is reported. */
interface GateRule { name: string; refuse: (c: GateCheck) => string | null }

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
export function parseAskGate(flags: { searched: RawFlag }): GateParse {
    const errors = GATE_RULES.map((r) => r.refuse(flags)).filter((m): m is string => m !== null);
    const searched = flags.searched.value?.replace(/\s+/g, ' ').trim();
    return { gate: searched && !errors.length ? { searched } : {}, errors };
}
