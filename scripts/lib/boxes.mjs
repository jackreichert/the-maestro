/**
 * Boxes: which kind of thing an open ledger item (or a day's note) really is. `triage` sorts by this
 * and `prime` and the handoff show it. Pure functions, no I/O: the caller passes the effective
 * approval of each item and the current date.
 *
 * The first matching rule wins. Compared with the research note's table, an approval is checked
 * before the generic "recorded rule" test so that boxes 2 and 3 can be reached at all.
 */

export const BOX = {
    RULE: 1, STANDING: 2, ONE_OFF: 3, NEEDS_JACK: 4, PASTE: 5, GATED: 6, INFLIGHT: 7, FINDING: 8, LEARNING: 9, DONE: 10, NOISE: 11,
};

export const BOX_TITLES = {
    1: 'Decisions / rules',
    2: 'Standing approvals',
    3: 'One-off approvals',
    4: 'Needs Jack',
    5: 'Paste blocks for Jack',
    6: 'Blocked / gated',
    7: 'In flight',
    8: 'Incidental findings',
    9: 'Learnings',
    10: 'Done',
    11: 'Noise',
};

/** Boxes whose items are records of something the user already said: closing them needs a promotion target. */
export const RECORD_BOXES = [BOX.RULE, BOX.STANDING, BOX.ONE_OFF];

const SAID = /^\s*(jack rule|jack:|standing approval|jack approves)/i;
const RUN_THIS = /\b(run|paste|yourself|block|jack runs)\b/i;
const FINDING = /could not be filed|follow[- ]?up|next session|\bTODO\b/i;
const LEARNED = /learned|lesson|ruled out|cause/i;
const TICKET_ID = /\b(?:[A-Za-z][A-Za-z0-9]*-)+\d{1,5}\b/;

/** Days from YYYY-MM-DD `from` to `to`; 0 when either is missing. */
export function daysBetween(from, to) {
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 864e5);
}

/**
 * Box number for one item. `approval` is the item's effective approval ('standing' | 'one-off' | undefined),
 * folded from the row, its closing row and any approval-tag rows by the caller.
 */
export function classify(item, approval) {
    const text = String(item.text || '');
    const hasTicket = Boolean(item.ticket) || TICKET_ID.test(text);
    switch (item.kind) {
    case 'done': case 'dropped': return BOX.DONE;
    case 'wip': return BOX.INFLIGHT;
    case 'blocked': return BOX.GATED;
    case 'question':
        if (approval === 'standing') return BOX.STANDING;
        if (approval === 'one-off') return BOX.ONE_OFF;
        if (item.paste || (RUN_THIS.test(text) && !text.includes('?'))) return BOX.PASTE;
        if (SAID.test(text) && !text.includes('?')) return BOX.RULE;
        return BOX.NEEDS_JACK;
    case 'decision':
        if (item.pending) return BOX.NEEDS_JACK;
        if (approval === 'standing') return BOX.STANDING;
        if (approval === 'one-off') return BOX.ONE_OFF;
        return BOX.RULE;
    case 'note':
        if (FINDING.test(text) && !hasTicket) return BOX.FINDING;
        if (LEARNED.test(text)) return BOX.LEARNING;
        return BOX.NOISE;
    default: return BOX.NOISE;
    }
}

/** Days after which an open item in a box is flagged stale; absent means the box never goes stale. */
export const STALE_AFTER_DAYS = { [BOX.NEEDS_JACK]: 2, [BOX.PASTE]: 2, [BOX.INFLIGHT]: 1 };

export const isStale = (box, item, today) => box in STALE_AFTER_DAYS && daysBetween(item.date, today) > STALE_AFTER_DAYS[box];

/** What `triage` proposes for an item in each box. */
export const ACTIONS = {
    1: 'promote to a memory file, then `rule --ref` (or `triage --apply` once a ref is on the row)',
    2: 'promote, confirm it is in the weekly approvals digest, then close',
    3: 'close once a ref resolves',
    4: 'carry; rewrite as a one-line question with options',
    5: 'carry in the paste list, with a link to the block file',
    6: 'carry with its gate written out',
    7: 'carry; confirm it is alive (ListAgents, branch-sweep) or drop it',
    8: 'file a ticket (xenophon), then log a pointer',
    9: 'copy into the handoff learnings and the repo CONTEXT.md',
    10: 'archive (roll)',
    11: 'archive silently',
};
