// Run: node --test scripts/lib/journal/ask-fields-board.test.ts
// Where the decision fields of an ask show up: status lines, the footer and triage. Legacy asks must read exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, mapStreamWith } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { footerLines, footerRows, groups } from './board.ts';
import type { BoardContext } from './board.ts';
import { fmt } from './format.ts';
import { triageItems, triageLines, triageReport } from './triage.ts';
import type { TriageContext } from './triage.ts';

const TODAY = '2026-10-07';
const legacy: LedgerRow = { id: 'old1', kind: 'question', ts: `${TODAY}T09:00:00Z`, date: TODAY, text: 'which policy?', stream: 'Avonlea' };
const twoWay: LedgerRow = { id: 'new1', kind: 'question', ts: `${TODAY}T09:01:00Z`, date: TODAY, text: 'use the nightly window?', stream: 'Avonlea', recommend: 'Yes, 01:00 to 03:00', door: 'two-way', default: 'apply the window', by: '2026-10-09', class: 'standard' };
const oneWay: LedgerRow = { id: 'new2', kind: 'question', ts: `${TODAY}T09:02:00Z`, date: TODAY, text: 'merge to staging?', stream: 'Avonlea', recommend: 'wait', door: 'one-way', by: '2026-10-12', class: 'expedite' };
const handEdited: LedgerRow = { id: 'new3', kind: 'question', ts: `${TODAY}T09:03:00Z`, date: TODAY, text: 'rotate the key?', stream: 'Avonlea', door: 'one-way', default: 'rotate it', class: 'standard' };
const noDoor: LedgerRow = { id: 'new4', kind: 'question', ts: `${TODAY}T09:04:00Z`, date: TODAY, text: 'which region?', stream: 'Avonlea', recommend: 'east', class: 'standard' };

function ctxFor(rows: LedgerRow[]): BoardContext {
    return {
        readLedger: () => rows, fold: (e) => fold(e, null), today: () => TODAY, rollPoint: () => undefined, has: parseArgs(['status']).has,
        mapStream: (s) => mapStreamWith(null, s), loadRegistry: () => null, ensureDir: () => {}, dir: '', dryRun: true,
    };
}
const awaiting = (rows: LedgerRow[]) => groups(ctxFor(rows)).awaiting;

test('a legacy ask prints exactly as before', () => {
    const [item] = awaiting([legacy]);
    assert.equal(fmt(item as never), '`old1` which policy? — model: unrecorded · used: unrecorded');
});

test('an ask with fields prints compact bits ahead of the usage marks, and a one-way ask names no default', () => {
    const [a, b, c, d] = awaiting([twoWay, oneWay, handEdited, noDoor]);
    assert.equal(fmt(a as never), '`new1` use the nightly window? — two-way · by 2026-10-09 · rec: Yes, 01:00 to 03:00 · if silent: apply the window · model: unrecorded · used: unrecorded');
    assert.equal(fmt(b as never, { showUsage: false }), '`new2` merge to staging? — one-way · by 2026-10-12 · expedite · rec: wait');
    assert.equal(fmt(c as never, { showUsage: false }), '`new3` rotate the key? — one-way', 'a hand-edited default on a one-way row is not shown as if it would fire');
    assert.equal(fmt(d as never, { showUsage: false }), '`new4` which region? — door not set: one-way · rec: east');
});

test('the footer is unchanged for legacy asks and notes one-way asks and the soonest decide-by otherwise', () => {
    const plain = awaiting([legacy]);
    assert.deepEqual(footerRows({ inflight: [], queued: [], blocked: [], awaiting: plain, paste: [] }, []), [{ name: 'Avonlea', done: 0, inflight: 0, queued: 0, awaiting: 1, paste: 0, blocked: 0 }]);
    assert.deepEqual(footerLines({ inflight: [], queued: [], blocked: [], awaiting: plain, paste: [] }, []), ['**Ledger (Avonlea):** 0 done today · 0 in flight · 1 awaiting you']);
    const mixed = awaiting([legacy, twoWay, oneWay, noDoor]);
    const rows = footerRows({ inflight: [], queued: [], blocked: [], awaiting: mixed, paste: [] }, []);
    assert.equal(rows[0]?.awaiting, 4);
    assert.equal(rows[0]?.oneWay, 2, 'the legacy ask is not counted as one-way: it carries no fields');
    assert.equal(rows[0]?.nextBy, '2026-10-09');
    assert.equal(footerLines({ inflight: [], queued: [], blocked: [], awaiting: mixed, paste: [] }, [])[0], '**Ledger (Avonlea):** 0 done today · 0 in flight · 4 awaiting you (2 one-way · next by 2026-10-09)');
});

test('triage carries the bits on an ask and prints them in its list', () => {
    const ctx: TriageContext = { readLedger: () => [legacy, twoWay, oneWay], fold: (e) => fold(e, null), today: () => TODAY, resolveRefFile: () => null };
    const items = triageItems(ctx, TODAY, TODAY);
    assert.equal(items.find((i) => i.id === 'old1')?.ask, undefined);
    assert.deepEqual(items.find((i) => i.id === 'new2')?.ask, ['one-way', 'by 2026-10-12', 'expedite', 'rec: wait']);
    const text = triageLines(triageReport(ctx, TODAY)).join('\n');
    assert.match(text, /new1 {2}use the nightly window\?  \[two-way; by 2026-10-09; rec: Yes, 01:00 to 03:00; if silent: apply the window\]/);
    assert.match(text, /old1 {2}which policy\?(?!  \[)/);
});
