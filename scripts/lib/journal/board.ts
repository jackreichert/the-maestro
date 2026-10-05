import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeDeferrals, isOpen, isQueued, isInFlight } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow, fold as foldRows } from '../ledger-core.ts';
import type { Args } from './args.ts';
import type { Store } from './store.ts';
import { fmt, slug } from './format.ts';

/** What the board reads from the run: the store, the fold, the clock, the stream mapping and the flags. */
export interface BoardContext extends Pick<Store, 'readLedger' | 'rollPoint' | 'loadRegistry' | 'ensureDir' | 'dir'> {
    fold: (entries: LedgerRow[]) => ReturnType<typeof foldRows>;
    today: () => string;
    has: Args['has'];
    mapStream: (stream: string | undefined) => string | undefined;
    dryRun: boolean;
}
type Streamed = { stream?: string };
/** The ledger folded into the lists the board shows; the `*On` functions answer for one day. */
export interface Groups {
    items: LedgerItem[];
    deferred: (LedgerItem & { deferredUntil: string | undefined })[];
    /** Open wip items that are running now. */
    inflight: LedgerItem[];
    /** Open wip items that are queued: to-dos not started. Never counted in `inflight`. */
    queued: LedgerItem[];
    blocked: LedgerItem[];
    awaiting: LedgerItem[];
    paste: LedgerItem[];
    decidedOn: (d: string) => LedgerItem[];
    rollPointOn: (d: string | undefined) => string | null | undefined;
    doneOn: (d: string, opts?: { sinceRoll?: boolean }) => LedgerItem[];
    notesOn: (d: string) => LedgerItem[];
    dates: (string | undefined)[];
}

export const streamTitle = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Every stream that has at least one open or done-today item, in first-seen order. */
export function activeStreams(...lists: Streamed[][]): string[] {
    const seen: string[] = [];
    for (const list of lists) for (const i of list) if (i.stream && !seen.includes(i.stream)) seen.push(i.stream);
    return seen;
}
export const inStream = <T extends Streamed>(arr: T[], s: string): T[] => arr.filter((i) => i.stream === s);
export const noStream = <T extends Streamed>(arr: T[]): T[] => arr.filter((i) => !i.stream);

export function groups(ctx: BoardContext, includeArchived = false): Groups {
    const { readLedger, fold, today, rollPoint } = ctx;
    // Folded items are the rows that have an id.
    const idOf = (i: LedgerItem): string => i.id ?? '';
    const entries = readLedger();
    const folded = fold(entries);
    const items = includeArchived ? folded.items : folded.items.filter((i) => !folded.hidden.has(idOf(i)));
    const deferred = activeDeferrals(entries, today());
    const open = items.filter((i) => isOpen(i) && !deferred.has(idOf(i)));
    return {
        items,
        deferred: items.filter((i) => isOpen(i) && deferred.has(idOf(i))).map((i) => ({ ...i, deferredUntil: deferred.get(idOf(i)) })),
        inflight: open.filter(isInFlight),
        queued: open.filter(isQueued),
        blocked: open.filter((i) => i.kind === 'blocked'),
        awaiting: open.filter((i) => (i.kind === 'question' || i.kind === 'decision') && !i.paste),
        paste: open.filter((i) => i.kind === 'question' && i.paste),
        decidedOn: (d: string) => items.filter((i) => i.closedBy?.kind === 'resolved' && i.closedBy.date === d),
        rollPointOn: (d: string | undefined) => rollPoint(entries, d),
        doneOn: (d: string, { sinceRoll = false }: { sinceRoll?: boolean } = {}) => {
            const cut = sinceRoll ? rollPoint(entries, d) : null;
            const after = (ts: string | undefined): boolean => !cut || (ts ?? '') > cut;
            return items
                .filter((i) => i.closedBy?.kind === 'done' && i.closedBy.date === d && after(i.closedBy.ts))
                .concat(items.filter((i) => i.state === 'done' && i.date === d && !i.closedBy && after(i.ts)));
        },
        notesOn: (d: string) => items.filter((i) => i.state === 'note' && i.date === d),
        dates: [...new Set(items.map((i) => i.date))].sort(),
    };
}

/** One reply-footer Ledger line as numbers: `name` is the stream (`other` for items with none), or null for the single plain line. */
export interface FooterRow { name: string | null; done: number; inflight: number; queued: number; awaiting: number; paste: number; blocked: number }

/**
 * The counts behind the reply-footer Ledger lines: one row per active stream (canonical registry names), then `other` for
 * items with no stream. With no streams at all it is the single plain row. The footer text and the status page both read this.
 */
export function footerRows(g: Pick<Groups, 'inflight' | 'queued' | 'blocked' | 'awaiting' | 'paste'>, done: LedgerItem[]): FooterRow[] {
    const streams = activeStreams(g.inflight, g.queued, g.blocked, g.awaiting, g.paste, done);
    const row = (name: string | null, pick: (i: LedgerItem) => boolean): FooterRow => {
        const n = (arr: LedgerItem[]): number => arr.filter(pick).length;
        return { name, done: n(done), inflight: n(g.inflight), queued: n(g.queued), awaiting: n(g.awaiting), paste: n(g.paste), blocked: n(g.blocked) };
    };
    if (!streams.length) return [row(null, () => true)];
    const rows = streams.map((s) => row(s, (i) => i.stream === s));
    const otherCount = [g.inflight, g.queued, g.blocked, g.awaiting, g.paste, done].reduce((a, arr) => a + noStream(arr).length, 0);
    if (otherCount) rows.push(row('other', (i) => !i.stream));
    return rows;
}

const footerLine = (r: FooterRow): string =>
    `**Ledger${r.name ? ` (${r.name})` : ''}:** ${r.done} done today · ${r.inflight} in flight${r.queued ? ` · ${r.queued} queued` : ''} · ${r.awaiting} awaiting you${r.paste ? ` · ${r.paste} to run` : ''}${r.blocked ? ` · ${r.blocked} blocked` : ''}`;

/** The reply-footer Ledger lines, one per `footerRows` row. */
export const footerLines = (g: Pick<Groups, 'inflight' | 'queued' | 'blocked' | 'awaiting' | 'paste'>, done: LedgerItem[]): string[] => footerRows(g, done).map(footerLine);

export function standupText(ctx: BoardContext, d: string): string {
    const { has } = ctx;
    const g = groups(ctx, has('include-archived'));
    const done = g.doneOn(d);
    const out = [`# Standup — ${d}`, ''];

    const section = (title: string, arr: LedgerItem[], empty: string): void => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push(empty, ''); return; }
        arr.forEach((i) => {
            const note = i.closedBy && i.closedBy.text !== i.text ? ` — ${i.closedBy.text}` : '';
            out.push(`- ${fmt(i, { showId: false, showUsage: false })}${note}`);
        });
        out.push('');
    };

    for (const s of activeStreams(done, g.inflight, g.queued, g.blocked, g.awaiting, g.paste)) {
        out.push(`# ${streamTitle(s)}`, '');
        section('Shipped', inStream(done, s), '_Nothing closed._');
        section('In flight', inStream(g.inflight, s), '_Nothing running._');
        if (inStream(g.queued, s).length) section('Queued', inStream(g.queued, s), '');
        section('Blocked', inStream(g.blocked, s), '_Nothing blocked._');
        section('Awaiting you', inStream(g.awaiting, s), '_No open questions._');
        if (inStream(g.paste, s).length) section('Paste blocks for you', inStream(g.paste, s), '');
        out.push('# Everything else', '');
    }
    section('Shipped', noStream(done), '_Nothing closed._');
    section('In flight', noStream(g.inflight), '_Nothing running._');
    if (noStream(g.queued).length) section('Queued', noStream(g.queued), '');
    section('Blocked', noStream(g.blocked), '_Nothing blocked._');
    section('Awaiting you', noStream(g.awaiting), '_No open questions._');
    if (noStream(g.paste).length) section('Paste blocks for you', noStream(g.paste), '');

    const decided = g.decidedOn(d);
    if (decided.length) {
        out.push('## Decided', '');
        decided.forEach((i) => out.push(`- ${i.text} — ${i.closedBy?.text}`));
        out.push('');
    }

    const notes = g.notesOn(d);
    if (notes.length) section('Notes', notes, '');
    return out.join('\n');
}

export function render(ctx: BoardContext, quiet = false, includeArchived = false): void {
    const { today, dryRun, ensureDir, dir } = ctx;
    const g = groups(ctx, includeArchived);
    const d = today();
    const rolledDates = g.dates.filter((x) => g.rollPointOn(x));

    const out = [
        '---',
        'generated: true',
        `updated: ${d}`,
        '---',
        '',
        '# Current ledger',
        '',
        '> Generated from `ledger.jsonl` by `journal.ts render`. Edits here are',
        '> overwritten — the JSONL is the source of truth. Dated archives are',
        '> written once and are yours to edit.',
        '',
    ];

    const section = (title: string, arr: LedgerItem[]): void => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push('_none_', ''); return; }
        arr.forEach((i) => out.push(`- ${fmt(i)}`));
        out.push('');
    };

    const doneToday = g.doneOn(d, { sinceRoll: true });
    for (const s of activeStreams(g.inflight, g.queued, g.blocked, g.awaiting, g.paste, doneToday)) {
        out.push(`# ${streamTitle(s)}`, '', `Stream page: [[${streamPageLink(s)}]]`, '');
        section('In flight', inStream(g.inflight, s));
        if (inStream(g.queued, s).length) section('Queued', inStream(g.queued, s));
        section('Blocked', inStream(g.blocked, s));
        section('Awaiting you', inStream(g.awaiting, s));
        if (inStream(g.paste, s).length) section('Paste blocks for you', inStream(g.paste, s));
        section(`Done today (${d})`, inStream(doneToday, s));
        out.push('# Everything else', '');
    }
    section('In flight', noStream(g.inflight));
    if (noStream(g.queued).length) section('Queued', noStream(g.queued));
    section('Blocked', noStream(g.blocked));
    section('Awaiting you', noStream(g.awaiting));
    if (noStream(g.paste).length) section('Paste blocks for you', noStream(g.paste));
    section(`Done today (${d})`, noStream(doneToday));
    if (g.rollPointOn(d)) out.push(`Earlier today archived -> [[${d}]]`, '');

    const retros = archivedRetros(ctx);
    if (retros.size) {
        out.push('## Archived streams', '');
        for (const s of retros.keys()) out.push(`- [[${streamPageLink(s)}]]`);
        out.push('');
    }

    if (rolledDates.length) {
        out.push('## Archive', '');
        rolledDates.slice().reverse().forEach((x) => out.push(`- [[${x}]]`));
        out.push('');
    }
    out.push('---', '', 'See CONTEXT.md in this project folder for durable project context.', '');

    if (dryRun) { if (!quiet) console.log(out.join('\n')); return; }
    ensureDir();
    writeFileSync(join(dir, 'CURRENT.md'), out.join('\n'));
    const pages = writeStreamPages(ctx, g, doneToday, retros, d);
    if (!quiet) console.log(`wrote ${join(dir, 'CURRENT.md')}${pages ? ` and ${pages} stream page(s) in ${join(dir, 'Streams')}` : ''}`);
}

export const streamPageLink = (s: string): string => `Streams/${slug(s)}`;

/**
 * stream -> retro path (or '') for each stream whose latest event is an archive. An archive or unarchive row whose
 * stream maps to undefined is the reserved `none` ("no stream"): there is nothing to archive, so the row is skipped.
 */
export function archivedRetros(ctx: BoardContext): Map<string, string> {
    const { readLedger, mapStream } = ctx;
    const out = new Map<string, string>();
    for (const e of readLedger()) {
        const stream = e.stream ? mapStream(e.stream) : undefined;
        if (stream === undefined) continue;
        if (e.kind === 'archive') out.set(stream, String(e.retro || ''));
        if (e.kind === 'unarchive') out.delete(stream);
    }
    return out;
}

/**
 * One generated page per stream: every active stream (open or done today) and every stream the registry
 * lists as active, so a quiet stream reads "none" instead of going stale; archived streams get a page that
 * only points at the retro. Returns how many pages were written.
 */
export function writeStreamPages(ctx: BoardContext, g: Groups, doneToday: LedgerItem[], retros: Map<string, string>, d: string): number {
    const { loadRegistry, dir } = ctx;
    const reg = loadRegistry();
    const registered = Object.entries(reg?.streams || {}).filter(([, m]) => m?.status !== 'archived').map(([k]) => k);
    const names = [...new Set([...activeStreams(g.inflight, g.blocked, g.awaiting, g.paste, g.deferred, doneToday), ...registered])].filter((s) => !retros.has(s));
    if (!names.length && !retros.size) return 0;
    const streamsDir = join(dir, 'Streams');
    mkdirSync(streamsDir, { recursive: true });
    const head = (s: string, extra: string[] = []): string[] => ['---', 'generated: true', `stream: ${s}`, `updated: ${d}`, '---', '', `# ${s}`, '',
        '> Generated from `ledger.jsonl` by `journal.ts render`. Edits here are overwritten. The combined board is [[CURRENT]].', '', ...extra];
    for (const s of names) {
        const out = head(s);
        const section = (title: string, arr: LedgerItem[]): void => {
            out.push(`## ${title}`, '');
            if (!arr.length) { out.push('_none_', ''); return; }
            arr.forEach((i) => out.push(`- ${fmt(i)}`));
            out.push('');
        };
        section('In flight', inStream(g.inflight, s));
        if (inStream(g.queued, s).length) section('Queued', inStream(g.queued, s));
        section('Blocked', inStream(g.blocked, s));
        section('Awaiting you', inStream(g.awaiting, s));
        if (inStream(g.paste, s).length) section('Paste blocks for you', inStream(g.paste, s));
        section(`Done today (${d})`, inStream(doneToday, s));
        writeFileSync(join(streamsDir, `${slug(s)}.md`), out.join('\n'));
    }
    for (const [s, retro] of retros) {
        const link = retro ? `Retro: [[${retro.split('/').slice(-1)[0].replace(/\.md$/, '')}]] (${retro})` : 'Retro: (path not recorded)';
        writeFileSync(join(streamsDir, `${slug(s)}.md`), head(s, ['This stream is **archived**. Its items are hidden from the board; `journal.ts unarchive` brings them back.', '', link, '']).join('\n'));
    }
    return names.length + retros.size;
}
