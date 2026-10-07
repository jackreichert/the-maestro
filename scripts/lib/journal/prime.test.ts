// Run: node --test scripts/lib/journal/prime.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, mapStreamWith } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { groups } from './board.ts';
import type { BoardContext } from './board.ts';
import { defaultPendingSince, gateReport, ghPrState, pendingTransitions, primeLines, startHereLines, trackerKeys } from './prime.ts';
import type { PrimeContext, TryRun } from './prime.ts';

const TODAY = '2026-10-03';
const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'wip', ts: `${TODAY}T09:00:00Z`, date: TODAY, text: 'build widget', stream: 'Alpha' },
    { id: 'bbbb', kind: 'blocked', ts: `${TODAY}T09:01:00Z`, date: TODAY, text: 'wait for date', gate: 'date:2099-01-01' },
    { id: 'cccc', kind: 'question', ts: `${TODAY}T09:02:00Z`, date: TODAY, text: 'which policy?' },
    { id: 'dddd', kind: 'done', ts: `${TODAY}T10:00:00Z`, date: TODAY, text: 'shipped FAKE-12 to staging', closes: 'eeee' },
    { id: 'eeee', kind: 'wip', ts: `${TODAY}T08:00:00Z`, date: TODAY, text: 'FAKE-12 work' },
];

function ctxFor(over: Partial<PrimeContext> = {}, tryRun: TryRun = () => ({ ok: false, missing: true, out: '', err: '' })): PrimeContext {
    const board: BoardContext = {
        readLedger: () => rows, fold: (entries) => fold(entries, null), today: () => TODAY,
        rollPoint: () => null, has: parseArgs(['prime']).has, mapStream: (s) => mapStreamWith(null, s),
        loadRegistry: () => null, ensureDir: () => {}, dir: '/nowhere', dryRun: false,
    };
    return {
        groups: (includeArchived) => groups(board, includeArchived), readLedger: board.readLedger, fold: board.fold, today: board.today,
        project: 'smoke', tryRun, ticketStatuses: () => null, arg: parseArgs(['prime']).arg, ...over,
    };
}

test('primeLines lists Needs Jack, blocked and in flight under a head and a foot, within the cap', () => {
    const lines = primeLines(ctxFor());
    assert.match(lines[0] ?? '', /^Board 2026-10-03 · project smoke$/);
    assert.ok(lines.some((l) => l.startsWith('Needs Jack (1)')));
    assert.ok(lines.some((l) => l.includes('bbbb wait for date [gate: date:2099-01-01]')));
    assert.ok(lines.length <= 40);
    assert.match(lines.at(-1) ?? '', /journal\.ts status/);
});

test('pendingTransitions finds done items with an unrecorded tracker key, and trackerKeys dedupes', () => {
    const pending = pendingTransitions(ctxFor(), '2026-09-01');
    assert.deepEqual(pending.map((r) => [r.key, r.id]), [['FAKE-12', 'eeee']]);
    assert.deepEqual(trackerKeys('FAKE-12 and FAKE-12', 'see FAKE-3', undefined), ['FAKE-12', 'FAKE-3']);
    assert.match(defaultPendingSince(), /^\d{4}-\d{2}-\d{2}$/);
});

test('gateReport reports a date gate as waiting, and ghPrState reads gh output or null', () => {
    const report = gateReport(ctxFor());
    assert.deepEqual(report.map((r) => [r.item.id, r.state, r.detail]), [['bbbb', 'waiting', 'until 2099-01-01']]);
    const ok = ctxFor({}, () => ({ ok: true, out: '{"state":"MERGED","mergedAt":"2026-10-01"}', err: '' }));
    assert.deepEqual(ghPrState(ok, 'o/r', 7), { state: 'MERGED', mergedAt: '2026-10-01' });
    assert.equal(ghPrState(ctxFor({}, () => ({ ok: true, out: '{"nope":1}', err: '' })), 'o/r', 7), null);
    assert.equal(ghPrState(ctxFor(), 'o/r', 7), null);
});

test('primeLines puts the update notice first and still holds the cap on a long board', () => {
    const many: LedgerRow[] = Array.from({ length: 60 }, (_, n) => ({ id: `w${String(n).padStart(3, '0')}`, kind: 'wip', ts: `${TODAY}T09:00:00Z`, date: TODAY, text: `task ${n}` }));
    const board = ctxFor();
    const ctx: PrimeContext = { ...board, readLedger: () => many, groups: (inc) => groups({ readLedger: () => many, fold: board.fold, today: board.today, rollPoint: () => null, has: parseArgs(['prime']).has, mapStream: (s) => mapStreamWith(null, s), loadRegistry: () => null, ensureDir: () => {}, dir: '/nowhere', dryRun: false }, inc), notices: ['the-maestro: 3 commit(s) behind origin/main.'] };
    const lines = primeLines(ctx);
    assert.equal(lines[0], 'the-maestro: 3 commit(s) behind origin/main.');
    assert.ok(lines.length <= 40, `${lines.length} lines`);
    assert.deepEqual(primeLines(ctxFor())[0]?.startsWith('Board'), true, 'no notice, no extra line');
});

test('primeLines lists Queued after In flight and keeps queued items out of In flight', () => {
    const queuedRows: LedgerRow[] = [
        ...rows,
        { id: 'qqq1', kind: 'wip', queued: true, ts: `${TODAY}T07:00:00Z`, date: TODAY, text: 'later job', stream: 'Alpha' },
        { id: 'qqq2', kind: 'queue', queues: 'aaaa', ts: `${TODAY}T11:00:00Z`, date: TODAY, text: 'queue' },
        { id: 'qqq3', kind: 'wip', ts: `${TODAY}T07:30:00Z`, date: TODAY, text: 'running job' },
    ];
    const base = ctxFor();
    const board: BoardContext = {
        readLedger: () => queuedRows, fold: (entries) => fold(entries, null), today: () => TODAY,
        rollPoint: () => null, has: parseArgs(['prime']).has, mapStream: (s) => mapStreamWith(null, s),
        loadRegistry: () => null, ensureDir: () => {}, dir: '/nowhere', dryRun: false,
    };
    const lines = primeLines({ ...base, readLedger: board.readLedger, groups: (a) => groups(board, a) });
    const at = (title: string): number => lines.findIndex((l) => l.startsWith(title));
    assert.ok(at('Queued (2)') > at('In flight (1)'), 'Queued follows In flight');
    assert.match(lines.slice(at('In flight (1)'), at('Queued (2)')).join('\n'), /qqq3 running job/);
    assert.doesNotMatch(lines.slice(at('In flight (1)'), at('Queued (2)')).join('\n'), /aaaa|qqq1/);
    assert.match(lines.slice(at('Queued (2)')).join('\n'), /aaaa build widget[^]*qqq1 later job/);
});

test('primeLines puts the Start-here pointer and the week line right after the Board line, inside the cap', () => {
    const lines = primeLines(ctxFor({ start: () => startHereLines('http://127.0.0.1:47700/', 'This week: ship the widget [Alpha]') }));
    assert.match(lines[0] ?? '', /^Board /);
    assert.equal(lines[1], 'Start here: journal.ts start-here · http://127.0.0.1:47700/#tab=start');
    assert.equal(lines[2], 'This week: ship the widget [Alpha]');
    assert.ok(lines.length <= 40);
});

test('startHereLines drops the link when no web URL is configured, and the week line when there is none', () => {
    assert.deepEqual(startHereLines('', null), ['Start here: journal.ts start-here']);
    assert.deepEqual(startHereLines('http://127.0.0.1:1/#tab=old', 'w'), ['Start here: journal.ts start-here · http://127.0.0.1:1/#tab=start', 'w']);
});
