// Run: node --test scripts/lib/journal/standup-range.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { groups } from './board.ts';
import type { BoardContext } from './board.ts';
import { MAX_DAYS, defaultDays, parseDays, standupRange, teamSafe } from './standup-range.ts';

const TODAY = '2026-10-26'; // a Monday
const at = (date: string, h = 10): string => `${date}T${String(h).padStart(2, '0')}:00:00Z`;
const rows: LedgerRow[] = [
    { id: 'aa11', kind: 'wip', ts: at('2026-10-23', 9), date: '2026-10-23', text: 'build widget', stream: 'alpha' },
    { id: 'aa12', kind: 'done', ts: at('2026-10-23'), date: '2026-10-23', text: 'widget shipped in #42', closes: 'aa11' },
    { id: 'bb11', kind: 'wip', ts: at('2026-10-25', 9), date: '2026-10-25', text: 'sunday cleanup', stream: 'alpha' },
    { id: 'bb12', kind: 'done', ts: at('2026-10-25'), date: '2026-10-25', text: 'cleanup done', closes: 'bb11' },
    { id: 'cc11', kind: 'wip', ts: at('2026-10-20', 9), date: '2026-10-20', text: 'old work', stream: 'beta' },
    { id: 'cc12', kind: 'done', ts: at('2026-10-20'), date: '2026-10-20', text: 'old work done', closes: 'cc11' },
    { id: 'dd11', kind: 'wip', ts: at('2026-10-26', 8), date: TODAY, text: 'port ABC-123 see the-maestro-441 `dd11` [[the-maestro-441]]', stream: 'beta' },
    { id: 'ee11', kind: 'blocked', ts: at('2026-10-26', 8), date: TODAY, text: 'waiting on review of /Users/me/dev/x' },
    { id: 'ff11', kind: 'question', ts: at('2026-10-26', 8), date: TODAY, text: 'pick a date?' },
];
const ctx = (): BoardContext => ({
    readLedger: () => rows, fold: (e) => fold(e, null), today: () => TODAY, rollPoint: () => undefined, has: parseArgs(['standup']).has,
    mapStream: (s) => s, loadRegistry: () => null, ensureDir: () => {}, dir: '/nowhere', dryRun: false,
});
const run = (days: number, tz?: string) => standupRange(groups(ctx()), { today: TODAY, days, ...(tz ? { tz } : {}) });

test('defaultDays: Monday reaches Friday, Sunday reaches Friday, any other day is yesterday', () => {
    assert.deepEqual(['2026-10-26', '2026-10-25', '2026-10-24', '2026-10-27', '2026-10-30'].map(defaultDays), [3, 2, 1, 1, 1]);
});

test('parseDays accepts 1..14 and rejects everything else without clamping', () => {
    assert.equal(parseDays('1'), 1);
    assert.equal(parseDays(String(MAX_DAYS)), MAX_DAYS);
    for (const bad of [null, undefined, '', '0', '15', '-1', '2.5', '1e1', 'abc', '3 ', '003x', '0003', '1000']) assert.equal(parseDays(bad), null, String(bad));
});

test('a Monday default window covers Friday to Sunday and leaves earlier days out', () => {
    const r = run(3);
    assert.deepEqual([r.from, r.to, r.defaultDays], ['2026-10-23', '2026-10-25', 3]);
    assert.match(r.text, /\*Yesterday \(Fri to Sun\)\*\n- Alpha\n  - widget shipped in #42\n  - cleanup done/);
    assert.doesNotMatch(r.text, /old work/);
});

test('one day back is just yesterday, and says so when nothing closed', () => {
    assert.match(run(1).text, /^\*Yesterday\*\n- Alpha\n  - cleanup done\n/);
    const none = standupRange(groups({ ...ctx(), readLedger: () => [] }), { today: TODAY, days: 1 });
    assert.match(none.text, /^\*Yesterday\*\nNothing closed in this window\.\n\n\*Today\*\nNothing in flight\.\n\n\*Blockers\*\nNone\.$/);
});

test('range is whole days in the given zone: a close at 23:30 UTC is the next local day east of UTC', () => {
    const late: LedgerRow[] = [{ id: 'zz11', kind: 'done', ts: '2026-10-24T23:30:00Z', date: '2026-10-24', text: 'late close' }];
    const c = { ...ctx(), readLedger: () => late };
    const g = groups(c);
    assert.match(standupRange(g, { today: TODAY, days: 1, tz: 'Asia/Jerusalem' }).text, /late close/); // 2026-10-25 02:30 local
    assert.doesNotMatch(standupRange(g, { today: TODAY, days: 1, tz: 'UTC' }).text, /late close/);
});

test('Today and Blockers come from the board as it stands, and the text is team-safe', () => {
    const t = run(3).text;
    assert.match(t, /\*Today\*\n- Beta\n  - port ABC-123 see/);
    assert.match(t, /\*Blockers\*\n- Other\n  - waiting on review of\n  - pick a date\?/);
    assert.doesNotMatch(t, /the-maestro-441|dd11|\[\[|\/Users\/|aa11/);
    assert.match(t, /ABC-123/);
});

test('teamSafe keeps tracker keys and PR numbers and removes ids, links and paths', () => {
    const ids = new Set(['ab12']);
    assert.equal(teamSafe('fix ZED-12 in #7 (ab12) `ab12` see Projects/x/Tickets/y.md and ~/notes/a.md', ids), 'fix ZED-12 in #7 see and');
    assert.equal(teamSafe('keep (word) and `code`', ids), 'keep (word) and `code`');
});

test('a stream is capped and each line clipped, so the standup stays short', () => {
    const many: LedgerRow[] = Array.from({ length: 8 }, (_, k) => ({ id: `m${k}00`, kind: 'done', ts: at('2026-10-25', k), date: '2026-10-25', text: `item ${k} ${'word '.repeat(60)}`, stream: 'alpha' }));
    const t = standupRange(groups({ ...ctx(), readLedger: () => many }), { today: TODAY, days: 1 }).text;
    assert.equal((t.match(/^  - item/gm) ?? []).length, 5);
    assert.match(t, /  - and 3 more/);
    assert.ok(t.split('\n').every((l) => l.length <= 150));
});
