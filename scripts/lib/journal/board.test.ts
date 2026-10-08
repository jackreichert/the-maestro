// Run: node --test scripts/lib/journal/board.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold, mapStreamWith } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { localDate } from '../status-page/priorities.ts';
import { parseArgs } from './args.ts';
import { activeStreams, archivedRetros, footerDone, footerLines, footerRows, groups, inStream, noStream, render, standupText, streamPageLink } from './board.ts';
import type { BoardContext } from './board.ts';

const TODAY = '2026-10-03';
const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'wip', ts: `${TODAY}T09:00:00Z`, date: TODAY, text: 'build widget', stream: 'Alpha', model: 'm', used: 'tool:x' },
    { id: 'bbbb', kind: 'wip', ts: `${TODAY}T09:01:00Z`, date: TODAY, text: 'untagged job' },
    { id: 'cccc', kind: 'question', ts: `${TODAY}T09:02:00Z`, date: TODAY, text: 'which policy?', stream: 'Beta' },
    { id: 'dddd', kind: 'done', ts: `${TODAY}T10:00:00Z`, date: TODAY, text: 'widget shipped', closes: 'aaaa' },
    { id: 'eeee', kind: 'rolled', ts: `${TODAY}T11:00:00Z`, date: TODAY, text: 'rolled' },
    { id: 'ffff', kind: 'note', ts: `${TODAY}T12:00:00Z`, date: TODAY, text: 'a note' },
];

/** A board context over in-memory rows and a temp journal dir; `dir` is where render writes. */
function ctxFor(over: Partial<BoardContext> = {}, argv: string[] = ['status']): BoardContext {
    const dir = mkdtempSync(join(tmpdir(), 'board-'));
    const registry = null;
    return {
        readLedger: () => rows,
        fold: (entries) => fold(entries, registry),
        today: () => TODAY,
        rollPoint: (entries, d) => entries.filter((e) => e.kind === 'rolled' && e.date === d).pop()?.ts,
        has: parseArgs(argv).has,
        mapStream: (s) => mapStreamWith(registry, s),
        loadRegistry: () => registry,
        ensureDir: () => {},
        dir,
        dryRun: false,
        ...over,
    };
}

test('groups splits open items by kind and answers per day', () => {
    const g = groups(ctxFor());
    assert.deepEqual(g.inflight.map((i) => i.id), ['bbbb']);
    assert.deepEqual(g.awaiting.map((i) => i.id), ['cccc']);
    assert.deepEqual(g.doneOn(TODAY).map((i) => i.id), ['aaaa']);
    assert.deepEqual(g.doneOn(TODAY, { sinceRoll: true }).map((i) => i.id), [], 'closed before the roll');
    assert.equal(g.rollPointOn(TODAY), `${TODAY}T11:00:00Z`);
    assert.deepEqual(g.notesOn(TODAY).map((i) => i.id), ['ffff']);
});

test('stream helpers keep first-seen order and separate the unstreamed', () => {
    const g = groups(ctxFor());
    assert.deepEqual(activeStreams(g.inflight, g.awaiting, g.doneOn(TODAY)), ['Beta', 'Alpha']);
    assert.deepEqual(inStream(g.inflight, 'Alpha'), []);
    assert.deepEqual(noStream(g.inflight).map((i) => i.id), ['bbbb']);
    assert.equal(streamPageLink('My Stream'), 'Streams/My-Stream');
});

test('a roll does not zero the footer done-today count, and a close just after midnight UTC is the previous ET day', () => {
    const et = 'America/New_York';
    const etDay = '2026-10-05';
    const afterMidnightUtc = '2026-10-06T00:30:00Z';
    assert.equal(localDate(new Date(afterMidnightUtc), et), etDay);
    assert.equal(localDate(new Date(afterMidnightUtc), 'UTC'), '2026-10-06');

    const rolled = groups(ctxFor());
    const classic = footerDone(rolled, TODAY);
    assert.deepEqual(classic.all.map((i) => i.id), ['aaaa']);
    assert.deepEqual(classic.sinceRoll?.map((i) => i.id), []);
    assert.match(footerLines(rolled, classic.all, classic.sinceRoll).join('\n'), /\*\*Ledger \(Alpha\):\*\* 1 done today · 0 since last roll · 0 in flight · 0 awaiting you/);

    const late: LedgerRow[] = [
        { id: 'aaaa', kind: 'wip', ts: '2026-10-05T15:00:00Z', date: '2026-10-05', text: 'morning', stream: 'Alpha' },
        { id: 'dddd', kind: 'done', ts: '2026-10-05T16:00:00Z', date: '2026-10-05', text: 'shipped before roll', closes: 'aaaa' },
        { id: 'eeee', kind: 'rolled', ts: '2026-10-05T18:00:00Z', date: '2026-10-05', text: 'rolled' },
        { id: 'bbbb', kind: 'wip', ts: '2026-10-05T23:00:00Z', date: '2026-10-05', text: 'late', stream: 'Alpha' },
        { id: 'ffff', kind: 'done', ts: afterMidnightUtc, date: '2026-10-06', text: 'still the previous ET day', closes: 'bbbb' },
    ];
    const g = groups(ctxFor({ readLedger: () => late }));
    assert.deepEqual(g.doneOn('2026-10-06').map((i) => i.id), ['bbbb'], 'stored date still follows the UTC day written on the row');
    assert.deepEqual(g.doneOn(etDay, { tz: et }).map((i) => i.id), ['aaaa', 'bbbb']);
    assert.deepEqual(g.doneOn('2026-10-06', { tz: et }).map((i) => i.id), []);
    const view = footerDone(g, etDay, { tz: et });
    assert.deepEqual(view.sinceRoll?.map((i) => i.id), ['bbbb']);
    assert.equal(footerRows(g, view.all, view.sinceRoll)[0]?.done, 2);
    assert.match(footerLines(g, view.all, view.sinceRoll).join('\n'), /2 done today · 1 since last roll/);
});

test('footerLines gives one line per stream and an other line', () => {
    const g = groups(ctxFor());
    const lines = footerLines(g, g.doneOn(TODAY));
    assert.deepEqual(lines, [
        '**Ledger (Beta):** 0 done today · 0 in flight · 1 awaiting you',
        '**Ledger (Alpha):** 1 done today · 0 in flight · 0 awaiting you',
        '**Ledger (other):** 0 done today · 1 in flight · 0 awaiting you',
    ]);
});

test('footerRows holds the numbers footerLines prints', () => {
    const g = groups(ctxFor());
    assert.deepEqual(footerRows(g, g.doneOn(TODAY)), [
        { name: 'Beta', done: 0, inflight: 0, queued: 0, awaiting: 1, paste: 0, blocked: 0 },
        { name: 'Alpha', done: 1, inflight: 0, queued: 0, awaiting: 0, paste: 0, blocked: 0 },
        { name: 'other', done: 0, inflight: 1, queued: 0, awaiting: 0, paste: 0, blocked: 0 },
    ]);
});

/** The base rows plus: a queued Alpha to-do, an Alpha item queued after it started, and a queued item with no stream. */
const withQueued = (): LedgerRow[] => [
    ...rows,
    { id: 'qqq1', kind: 'wip', queued: true, ts: `${TODAY}T08:00:00Z`, date: TODAY, text: 'later alpha', stream: 'Alpha' },
    { id: 'qqq2', kind: 'wip', ts: `${TODAY}T08:01:00Z`, date: TODAY, text: 'started then parked', stream: 'Alpha' },
    { id: 'qqq3', kind: 'queue', queues: 'qqq2', ts: `${TODAY}T08:02:00Z`, date: TODAY, text: 'queue' },
    { id: 'qqq4', kind: 'wip', queued: true, ts: `${TODAY}T08:03:00Z`, date: TODAY, text: 'later loose' },
];

test('groups keeps queued items out of inflight and apart from every other list', () => {
    const g = groups(ctxFor({ readLedger: withQueued }));
    assert.deepEqual(g.inflight.map((i) => i.id), ['bbbb']);
    assert.deepEqual(g.queued.map((i) => i.id), ['qqq1', 'qqq2', 'qqq4']);
    assert.deepEqual(g.awaiting.map((i) => i.id), ['cccc']);
});

test('footer rows and lines add the queued count only where it is above zero, and a queued-only stream still gets a line', () => {
    const g = groups(ctxFor({ readLedger: withQueued }));
    assert.deepEqual(footerRows(g, g.doneOn(TODAY)).map((r) => [r.name, r.inflight, r.queued]), [['Alpha', 0, 2], ['Beta', 0, 0], ['other', 1, 1]]);
    assert.deepEqual(footerLines(g, g.doneOn(TODAY)), [
        '**Ledger (Alpha):** 1 done today · 0 in flight · 2 queued · 0 awaiting you',
        '**Ledger (Beta):** 0 done today · 0 in flight · 1 awaiting you',
        '**Ledger (other):** 0 done today · 1 in flight · 1 queued · 0 awaiting you',
    ]);
    const byId = (id: string): LedgerRow => withQueued().find((r) => r.id === id) as LedgerRow;
    const streamed = groups(ctxFor({ readLedger: () => [byId('qqq1')] }));
    assert.deepEqual(footerLines(streamed, []), ['**Ledger (Alpha):** 0 done today · 0 in flight · 1 queued · 0 awaiting you']);
    const loose = groups(ctxFor({ readLedger: () => [byId('qqq4')] }));
    assert.deepEqual(footerLines(loose, []), ['**Ledger:** 0 done today · 0 in flight · 1 queued · 0 awaiting you']);
});

test('standupText and render list Queued apart from In flight, and only when something is queued', () => {
    const plain = ctxFor();
    assert.doesNotMatch(standupText(plain, TODAY), /Queued/);
    const ctx = ctxFor({ readLedger: withQueued });
    const text = standupText(ctx, TODAY);
    assert.match(text, /## Queued\n\n- later alpha\n- started then parked\n/);
    assert.doesNotMatch(text.split('## Queued')[0].split('# Everything else')[0], /later alpha/);
    render(ctx, true);
    const current = readFileSync(join(ctx.dir, 'CURRENT.md'), 'utf8');
    assert.match(current, /## In flight\n\n_none_\n\n## Queued\n\n- `qqq1` later alpha/);
});

test('standupText lists shipped work by stream and the notes', () => {
    const text = standupText(ctxFor(), TODAY);
    assert.match(text, /^# Standup — 2026-10-03\n/);
    assert.match(text, /# Alpha\n\n## Shipped\n\n- build widget — widget shipped/);
    assert.match(text, /## Notes\n\n- a note/);
});

test('render writes CURRENT.md and one page per active stream, and a dry run writes nothing', () => {
    const ctx = ctxFor();
    render(ctx, true);
    const current = readFileSync(join(ctx.dir, 'CURRENT.md'), 'utf8');
    assert.match(current, /^---\ngenerated: true\nupdated: 2026-10-03\n---\n/);
    assert.match(current, /Stream page: \[\[Streams\/Beta\]\]/);
    assert.deepEqual(readdirSync(join(ctx.dir, 'Streams')).sort(), ['Beta.md']);
    const dry = ctxFor({ dryRun: true });
    render(dry, true);
    assert.deepEqual(readdirSync(dry.dir), []);
});

test('archive and unarchive rows for the reserved none stream are skipped, not keyed as undefined', () => {
    const withNone: LedgerRow[] = [
        ...rows,
        { id: 'gggg', kind: 'archive', ts: `${TODAY}T13:00:00Z`, date: TODAY, text: 'archived stream none', stream: 'none', ids: ['bbbb'], retro: '/x/retro.md' },
        { id: 'hhhh', kind: 'unarchive', ts: `${TODAY}T13:01:00Z`, date: TODAY, text: 'unarchived stream none', stream: 'None', ids: ['bbbb'] },
        { id: 'iiii', kind: 'archive', ts: `${TODAY}T13:02:00Z`, date: TODAY, text: 'archived stream none', stream: 'none', ids: ['bbbb'], retro: '/x/retro.md' },
    ];
    const ctx = ctxFor({ readLedger: () => withNone });
    assert.deepEqual([...archivedRetros(ctx)], []);
    render(ctx, true);
    assert.match(readFileSync(join(ctx.dir, 'CURRENT.md'), 'utf8'), /Stream page: \[\[Streams\/Beta\]\]/);
    assert.deepEqual(readdirSync(join(ctx.dir, 'Streams')).sort(), ['Beta.md']);
    const real = ctxFor({ readLedger: () => [...withNone, { id: 'jjjj', kind: 'archive', ts: `${TODAY}T14:00:00Z`, date: TODAY, text: 'archived stream Beta', stream: 'Beta', ids: ['cccc'], retro: '/x/Beta-retro.md' }] });
    assert.deepEqual([...archivedRetros(real)], [['Beta', '/x/Beta-retro.md']]);
});
