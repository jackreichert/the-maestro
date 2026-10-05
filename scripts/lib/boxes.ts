/**
 * Boxes: which kind of thing an open ledger item (or a day's note) really is. `triage` sorts by this
 * and `prime` and the handoff show it. Pure functions, no I/O: the caller passes the effective
 * approval of each item and the current date.
 *
 * The first matching rule wins. Compared with the research note's table, an approval is checked
 * before the generic "recorded rule" test so that boxes 2 and 3 can be reached at all.
 *
 * Only a non-pending `decision`, or a row carrying an explicit approval, can be a record (boxes 1 to 3).
 * Wording alone never makes a question a rule, because triage --apply closes records: a real question
 * must not be closed on a regex.
 */

/** The fields of a ledger row that box classification reads. */
export interface BoxItem { kind?: string; text?: string; ticket?: string; paste?: string; pending?: boolean; date?: string; queued?: boolean }

/** An item's effective approval: 'standing' or 'one-off' when valid. Read back from the ledger as text, so any string can arrive. */
export type Approval = string | undefined;

export type Gate =
    | { type: 'gh:pr'; repo: string; number: number }
    | { type: 'date'; date: string }
    | { type: 'ticket'; id: string };

export interface GateStatus { state: 'waiting' | 'cleared' | 'unknown'; detail: string }

export const BOX = {
    RULE: 1, STANDING: 2, ONE_OFF: 3, NEEDS_JACK: 4, PASTE: 5, GATED: 6, INFLIGHT: 7, FINDING: 8, LEARNING: 9, DONE: 10, NOISE: 11,
};

export const BOX_TITLES: Record<number, string> = {
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

const RUN_THIS = /\b(run|paste|yourself|block|jack runs)\b/i;
const FINDING = /could not be filed|follow[- ]?up|next session|\bTODO\b/i;
const LEARNED = /learned|lesson|ruled out|\bcause\b/i;
const TICKET_ID = /\b(?:[A-Za-z][A-Za-z0-9]*-)+\d{1,5}\b/;

/** Days from YYYY-MM-DD `from` to `to`; 0 when either is missing. */
export function daysBetween(from: string | undefined, to: string | undefined): number {
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 864e5);
}

/**
 * Box number for one item. `approval` is the item's effective approval ('standing' | 'one-off' | undefined),
 * folded from the row, its closing row and any approval-tag rows by the caller.
 */
export function classify(item: BoxItem, approval?: Approval): number {
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
export const STALE_AFTER_DAYS: Record<number, number> = { [BOX.NEEDS_JACK]: 2, [BOX.PASTE]: 2, [BOX.INFLIGHT]: 1 };

export const isStale = (box: number, item: BoxItem, today: string): boolean => {
    if (item.queued) return false;   // a queued to-do has not started, so it cannot have run too long
    const limit = STALE_AFTER_DAYS[box];
    return limit !== undefined && daysBetween(item.date, today) > limit;
};

/** What `triage` proposes for an item in each box. */
export const ACTIONS: Record<number, string> = {
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

// ── gates ───────────────────────────────────────────────────────────────────

const GATE = /^(?:gh:pr:([\w.-]+(?:\/[\w.-]+)?)#(\d+)|date:(\d{4}-\d{2}-\d{2})|ticket:([\w.-]+))$/;

/** Parsed gate, or null when `spec` is not `gh:pr:<repo>#N`, `date:YYYY-MM-DD` or `ticket:<id>`. */
export function parseGate(spec: unknown): Gate | null {
    const m = GATE.exec(String(spec || ''));
    if (!m) return null;
    const [, repo = '', prNumber, date, id = ''] = m;
    if (prNumber) return { type: 'gh:pr', repo, number: Number(prNumber) };
    if (date) return Number.isNaN(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ? null : { type: 'date', date };
    return { type: 'ticket', id };
}

/**
 * Where a gate stands: { state: 'waiting' | 'cleared' | 'unknown', detail }. The caller supplies how to look
 * things up, so this stays pure: `pr(repo, number)` returns { state, mergedAt } or null when it cannot tell,
 * `ticket(id)` returns a status string or null.
 */
export function gateStatus(
    spec: unknown,
    today: string,
    { pr, ticket }: { pr: (repo: string, number: number) => { state?: string; mergedAt?: string } | null; ticket: (id: string) => string | null },
): GateStatus {
    const g = parseGate(spec);
    if (!g) return { state: 'unknown', detail: 'unreadable gate' };
    if (g.type === 'date') return today >= g.date ? { state: 'cleared', detail: `${g.date} has arrived` } : { state: 'waiting', detail: `until ${g.date}` };
    if (g.type === 'ticket') {
        const status = ticket(g.id);
        if (!status) return { state: 'unknown', detail: `ticket ${g.id}: status unavailable` };
        return status === 'closed' ? { state: 'cleared', detail: `ticket ${g.id} is closed` } : { state: 'waiting', detail: `ticket ${g.id} is ${status}` };
    }
    const info = pr(g.repo, g.number);
    if (!info) return { state: 'unknown', detail: `${g.repo}#${g.number}: gh could not say` };
    if (info.state === 'MERGED') return { state: 'cleared', detail: `${g.repo}#${g.number} merged` };
    if (info.state === 'CLOSED') return { state: 'unknown', detail: `${g.repo}#${g.number} closed without merging` };
    return { state: 'waiting', detail: `${g.repo}#${g.number} is ${String(info.state).toLowerCase()}` };
}
