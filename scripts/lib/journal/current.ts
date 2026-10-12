import type { LedgerItem } from '../ledger-core.ts';
import { fmt, clip } from './format.ts';

/** Rows shown per CURRENT section before the rest is left to the stream pages. */
export const CURRENT_ROW_CAP = 12;
/** Longest a row's text runs in CURRENT.md; the full text is on the stream page. */
export const CURRENT_TEXT_CLIP = 120;
/** Dated archives linked from CURRENT.md; older ones are on the archive index page. */
export const CURRENT_ARCHIVE_CAP = 7;
/** The generated page listing every dated archive. */
/** Name of the generated page for items that carry no stream. */
export const OTHER_STREAM = 'Other';
export const ARCHIVE_INDEX = 'Archive';

/** What the slim CURRENT.md needs: the open lists, the done-today count, the day and where the full lists live. */
export interface CurrentInput {
    day: string;
    inflight: LedgerItem[];
    queued: LedgerItem[];
    blocked: LedgerItem[];
    awaiting: LedgerItem[];
    paste: LedgerItem[];
    doneToday: LedgerItem[];
    /** Active stream names, each with a generated page at `pageLink(name)`. */
    streams: string[];
    pageLink: (stream: string) => string;
    archivedStreamLinks: string[];
    archiveDates: string[];
    rolledToday: boolean;
    /** Today's priorities as plain lines; empty when none are set. */
    priorities: string[];
}

const row = (i: LedgerItem, page: (s: string) => string): string => {
    const where = i.stream ? ` [[${page(i.stream)}|${i.stream}]]` : '';
    return `- ${fmt({ ...i, text: clip(i.text, CURRENT_TEXT_CLIP) }, { showUsage: false })}${where}`;
};

/**
 * The slim CURRENT.md: priorities, the in-flight rows, the asks awaiting the user, and links to everything else.
 * Queued, blocked and done work is a count here and the full list on the stream page, so the file stays readable in one go.
 */
export function renderCurrent(c: CurrentInput): string[] {
    const out = [
        '---', 'generated: true', `updated: ${c.day}`, '---', '',
        '# Current ledger', '',
        '> Generated from `ledger.jsonl` by `journal.ts render`. Edits here are overwritten. This is the slim view:',
        '> priorities, what is in flight and what awaits you. The full lists are on the stream pages linked below.', '',
    ];
    if (c.priorities.length) out.push('## Priorities', '', ...c.priorities.map((p, n) => `${n + 1}. ${p}`), '');

    const section = (title: string, items: LedgerItem[]): void => {
        out.push(`## ${title}`, '');
        if (!items.length) { out.push('_none_', ''); return; }
        items.slice(0, CURRENT_ROW_CAP).forEach((i) => out.push(row(i, c.pageLink)));
        if (items.length > CURRENT_ROW_CAP) out.push(`- _${items.length - CURRENT_ROW_CAP} more: see the stream pages below._`);
        out.push('');
    };
    section('In flight', c.inflight);
    section('Awaiting you', c.awaiting);
    if (c.paste.length) section('Paste blocks for you', c.paste);

    const counts = [`${c.queued.length} queued`, `${c.blocked.length} blocked`, `${c.doneToday.length} done today (${c.day})`];
    out.push('## Everything else, by link', '', `${counts.join(' · ')}. Each is listed in full on the stream pages.`, '');
    const inStream = (list: LedgerItem[], s: string): number => list.filter((i) => i.stream === s).length;
    for (const s of c.streams) {
        const bits = [
            [c.inflight, 'in flight'], [c.queued, 'queued'], [c.blocked, 'blocked'], [c.awaiting, 'awaiting'], [c.paste, 'to run'], [c.doneToday, 'done'],
        ].map(([list, label]) => ({ n: inStream(list as LedgerItem[], s), label })).filter((b) => b.n).map((b) => `${b.n} ${b.label}`);
        out.push(`- [[${c.pageLink(s)}]]${bits.length ? `: ${bits.join(', ')}` : ''}`);
    }
    const loose = (list: LedgerItem[]): number => list.filter((i) => !i.stream).length;
    const looseTotal = loose(c.inflight) + loose(c.queued) + loose(c.blocked) + loose(c.awaiting) + loose(c.paste) + loose(c.doneToday);
    if (looseTotal) out.push(`- [[${c.pageLink(OTHER_STREAM)}]]: ${looseTotal} item(s) with no stream`);
    out.push('');
    if (c.rolledToday) out.push(`Earlier today archived -> [[${c.day}]]`, '');
    if (c.archivedStreamLinks.length) out.push('## Archived streams', '', ...c.archivedStreamLinks.map((l) => `- [[${l}]]`), '');
    if (c.archiveDates.length) {
        const more = c.archiveDates.length - CURRENT_ARCHIVE_CAP;
        out.push('## Archive', '', ...c.archiveDates.slice(0, CURRENT_ARCHIVE_CAP).map((x) => `- [[${x}]]`));
        if (more > 0) out.push(`- ${more} older: [[${ARCHIVE_INDEX}]]`);
        out.push('');
    }
    out.push('---', '', 'See CONTEXT.md in this project folder for durable project context.', '');
    return out;
}
