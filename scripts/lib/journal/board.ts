import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeDeferrals, isOpen } from '../ledger-core.ts';
import { fmt, slug } from './format.ts';

export const streamTitle = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every stream that has at least one open or done-today item, in first-seen order. */
export function activeStreams(...lists) {
    const seen = [];
    for (const list of lists) for (const i of list) if (i.stream && !seen.includes(i.stream)) seen.push(i.stream);
    return seen;
}
export const inStream = (arr, s) => arr.filter((i) => i.stream === s);
export const noStream = (arr) => arr.filter((i) => !i.stream);

export function groups(ctx, includeArchived = false) {
    const { readLedger, fold, today, rollPoint } = ctx;
    const entries = readLedger();
    const folded = fold(entries);
    const items = includeArchived ? folded.items : folded.items.filter((i) => !folded.hidden.has(i.id));
    const deferred = activeDeferrals(entries, today());
    const open = items.filter((i) => isOpen(i) && !deferred.has(i.id));
    return {
        items,
        deferred: items.filter((i) => isOpen(i) && deferred.has(i.id)).map((i) => ({ ...i, deferredUntil: deferred.get(i.id) })),
        inflight: open.filter((i) => i.kind === 'wip'),
        blocked: open.filter((i) => i.kind === 'blocked'),
        awaiting: open.filter((i) => (i.kind === 'question' || i.kind === 'decision') && !i.paste),
        paste: open.filter((i) => i.kind === 'question' && i.paste),
        decidedOn: (d) => items.filter((i) => i.closedBy?.kind === 'resolved' && i.closedBy.date === d),
        rollPointOn: (d) => rollPoint(entries, d),
        doneOn: (d, { sinceRoll = false } = {}) => {
            const cut = sinceRoll ? rollPoint(entries, d) : null;
            const after = (ts) => !cut || ts > cut;
            return items
                .filter((i) => i.closedBy?.kind === 'done' && i.closedBy.date === d && after(i.closedBy.ts))
                .concat(items.filter((i) => i.state === 'done' && i.date === d && !i.closedBy && after(i.ts)));
        },
        notesOn: (d) => items.filter((i) => i.state === 'note' && i.date === d),
        dates: [...new Set(items.map((i) => i.date))].sort(),
    };
}

/**
 * The reply-footer Ledger lines: one per active stream (canonical registry names), then `other` for
 * items with no stream. With no streams at all it is the single plain `Ledger` line.
 */
export function footerLines(g, done) {
    const streams = activeStreams(g.inflight, g.blocked, g.awaiting, g.paste, done);
    const fmtLine = (name, pick) => {
        const n = (arr) => arr.filter(pick).length;
        const blocked = n(g.blocked);
        const paste = n(g.paste);
        return `**Ledger${name ? ` (${name})` : ''}:** ${n(done)} done today · ${n(g.inflight)} in flight · ${n(g.awaiting)} awaiting you${paste ? ` · ${paste} to run` : ''}${blocked ? ` · ${blocked} blocked` : ''}`;
    };
    if (!streams.length) return [fmtLine(null, () => true)];
    const lines = streams.map((s) => fmtLine(s, (i) => i.stream === s));
    const otherCount = [g.inflight, g.blocked, g.awaiting, g.paste, done].reduce((a, arr) => a + noStream(arr).length, 0);
    if (otherCount) lines.push(fmtLine('other', (i) => !i.stream));
    return lines;
}

export function standupText(ctx, d) {
    const { has } = ctx;
    const g = groups(ctx, has('include-archived'));
    const done = g.doneOn(d);
    const out = [`# Standup — ${d}`, ''];

    const section = (title, arr, empty) => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push(empty, ''); return; }
        arr.forEach((i) => {
            const note = i.closedBy && i.closedBy.text !== i.text ? ` — ${i.closedBy.text}` : '';
            out.push(`- ${fmt(i, { showId: false, showUsage: false })}${note}`);
        });
        out.push('');
    };

    for (const s of activeStreams(done, g.inflight, g.blocked, g.awaiting, g.paste)) {
        out.push(`# ${streamTitle(s)}`, '');
        section('Shipped', inStream(done, s), '_Nothing closed._');
        section('In flight', inStream(g.inflight, s), '_Nothing running._');
        section('Blocked', inStream(g.blocked, s), '_Nothing blocked._');
        section('Awaiting you', inStream(g.awaiting, s), '_No open questions._');
        if (inStream(g.paste, s).length) section('Paste blocks for you', inStream(g.paste, s), '');
        out.push('# Everything else', '');
    }
    section('Shipped', noStream(done), '_Nothing closed._');
    section('In flight', noStream(g.inflight), '_Nothing running._');
    section('Blocked', noStream(g.blocked), '_Nothing blocked._');
    section('Awaiting you', noStream(g.awaiting), '_No open questions._');
    if (noStream(g.paste).length) section('Paste blocks for you', noStream(g.paste), '');

    const decided = g.decidedOn(d);
    if (decided.length) {
        out.push('## Decided', '');
        decided.forEach((i) => out.push(`- ${i.text} — ${i.closedBy.text}`));
        out.push('');
    }

    const notes = g.notesOn(d);
    if (notes.length) section('Notes', notes, '');
    return out.join('\n');
}

export function render(ctx, quiet = false, includeArchived = false) {
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
        '> Generated from `ledger.jsonl` by `journal.mjs render`. Edits here are',
        '> overwritten — the JSONL is the source of truth. Dated archives are',
        '> written once and are yours to edit.',
        '',
    ];

    const section = (title, arr) => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push('_none_', ''); return; }
        arr.forEach((i) => out.push(`- ${fmt(i)}`));
        out.push('');
    };

    const doneToday = g.doneOn(d, { sinceRoll: true });
    for (const s of activeStreams(g.inflight, g.blocked, g.awaiting, g.paste, doneToday)) {
        out.push(`# ${streamTitle(s)}`, '', `Stream page: [[${streamPageLink(s)}]]`, '');
        section('In flight', inStream(g.inflight, s));
        section('Blocked', inStream(g.blocked, s));
        section('Awaiting you', inStream(g.awaiting, s));
        if (inStream(g.paste, s).length) section('Paste blocks for you', inStream(g.paste, s));
        section(`Done today (${d})`, inStream(doneToday, s));
        out.push('# Everything else', '');
    }
    section('In flight', noStream(g.inflight));
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

export const streamPageLink = (s) => `Streams/${slug(s)}`;

/** stream -> retro path (or '') for each stream whose latest event is an archive. */
export function archivedRetros(ctx) {
    const { readLedger, mapStream } = ctx;
    const out = new Map();
    for (const e of readLedger()) {
        if (e.kind === 'archive' && e.stream) out.set(mapStream(e.stream), e.retro || '');
        if (e.kind === 'unarchive' && e.stream) out.delete(mapStream(e.stream));
    }
    return out;
}

/**
 * One generated page per stream: every active stream (open or done today) and every stream the registry
 * lists as active, so a quiet stream reads "none" instead of going stale; archived streams get a page that
 * only points at the retro. Returns how many pages were written.
 */
export function writeStreamPages(ctx, g, doneToday, retros, d) {
    const { loadRegistry, dir } = ctx;
    const reg = loadRegistry();
    const registered = Object.entries(reg?.streams || {}).filter(([, m]) => m?.status !== 'archived').map(([k]) => k);
    const names = [...new Set([...activeStreams(g.inflight, g.blocked, g.awaiting, g.paste, g.deferred, doneToday), ...registered])].filter((s) => !retros.has(s));
    if (!names.length && !retros.size) return 0;
    const streamsDir = join(dir, 'Streams');
    mkdirSync(streamsDir, { recursive: true });
    const head = (s, extra = []) => ['---', 'generated: true', `stream: ${s}`, `updated: ${d}`, '---', '', `# ${s}`, '',
        '> Generated from `ledger.jsonl` by `journal.mjs render`. Edits here are overwritten. The combined board is [[CURRENT]].', '', ...extra];
    for (const s of names) {
        const out = head(s);
        const section = (title, arr) => {
            out.push(`## ${title}`, '');
            if (!arr.length) { out.push('_none_', ''); return; }
            arr.forEach((i) => out.push(`- ${fmt(i)}`));
            out.push('');
        };
        section('In flight', inStream(g.inflight, s));
        section('Blocked', inStream(g.blocked, s));
        section('Awaiting you', inStream(g.awaiting, s));
        if (inStream(g.paste, s).length) section('Paste blocks for you', inStream(g.paste, s));
        section(`Done today (${d})`, inStream(doneToday, s));
        writeFileSync(join(streamsDir, `${slug(s)}.md`), out.join('\n'));
    }
    for (const [s, retro] of retros) {
        const link = retro ? `Retro: [[${retro.split('/').pop().replace(/\.md$/, '')}]] (${retro})` : 'Retro: (path not recorded)';
        writeFileSync(join(streamsDir, `${slug(s)}.md`), head(s, ['This stream is **archived**. Its items are hidden from the board; `journal.mjs unarchive` brings them back.', '', link, '']).join('\n'));
    }
    return names.length + retros.size;
}
