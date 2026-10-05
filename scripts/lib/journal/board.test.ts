// Run: node --test scripts/lib/journal/board.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold, mapStreamWith } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { activeStreams, archivedRetros, footerLines, footerRows, groups, inStream, noStream, render, standupText, streamPageLink } from './board.ts';
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
        { name: 'Beta', done: 0, inflight: 0, awaiting: 1, paste: 0, blocked: 0 },
        { name: 'Alpha', done: 1, inflight: 0, awaiting: 0, paste: 0, blocked: 0 },
        { name: 'other', done: 0, inflight: 1, awaiting: 0, paste: 0, blocked: 0 },
    ]);
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
