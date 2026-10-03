// Run: node --test scripts/boxes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOX, classify, isStale, daysBetween } from './lib/boxes.ts';

test('classify: first matching rule wins, approvals before the generic rule', () => {
    assert.equal(classify({ kind: 'decision', text: 'x' }), BOX.RULE);
    assert.equal(classify({ kind: 'decision', text: 'x' }, 'standing'), BOX.STANDING);
    assert.equal(classify({ kind: 'decision', text: 'x' }, 'one-off'), BOX.ONE_OFF);
    assert.equal(classify({ kind: 'decision', text: 'x', pending: true }, 'standing'), BOX.NEEDS_JACK);
    assert.equal(classify({ kind: 'question', text: 'Jack rule: always squash' }), BOX.NEEDS_JACK, 'wording alone never makes a question a record');
    assert.equal(classify({ kind: 'question', text: 'Jack: pick a branch' }, 'standing'), BOX.STANDING);
    assert.equal(classify({ kind: 'question', text: 'run the read-only SQL' }), BOX.PASTE);
    assert.equal(classify({ kind: 'question', text: 'should I run it?' }), BOX.NEEDS_JACK);
    assert.equal(classify({ kind: 'question', text: 'anything', paste: '/x' }), BOX.PASTE);
    assert.equal(classify({ kind: 'wip', text: 'x' }), BOX.INFLIGHT);
    assert.equal(classify({ kind: 'blocked', text: 'x' }), BOX.GATED);
});

test('classify notes: a finding needs no ticket on it, a learning is kept, the rest is noise', () => {
    assert.equal(classify({ kind: 'note', text: 'follow-up: restart the watcher next session' }), BOX.FINDING);
    assert.equal(classify({ kind: 'note', text: 'follow-up filed as the-maestro-016' }), BOX.NOISE);
    assert.equal(classify({ kind: 'note', text: 'follow-up', ticket: 'X-1' }), BOX.NOISE);
    assert.equal(classify({ kind: 'note', text: 'root cause was the cwd' }), BOX.LEARNING);
    assert.equal(classify({ kind: 'note', text: 'posted reply' }), BOX.NOISE);
    assert.equal(classify({ kind: 'note', text: 'skipped because it was late' }), BOX.NOISE);
});

test('staleness: needs-jack and paste after 2 days, in-flight after 1, others never', () => {
    assert.equal(daysBetween('2026-10-01', '2026-10-03'), 2);
    assert.equal(isStale(BOX.NEEDS_JACK, { date: '2026-10-01' }, '2026-10-03'), false);
    assert.equal(isStale(BOX.NEEDS_JACK, { date: '2026-10-01' }, '2026-10-04'), true);
    assert.equal(isStale(BOX.INFLIGHT, { date: '2026-10-01' }, '2026-10-03'), true);
    assert.equal(isStale(BOX.GATED, { date: '2026-01-01' }, '2026-10-03'), false);
});

import { parseGate, gateStatus } from './lib/boxes.ts';
import { activeDeferrals } from './lib/ledger-core.ts';

test('parseGate accepts the three forms and nothing else', () => {
    assert.deepEqual(parseGate('gh:pr:org/repo#9'), { type: 'gh:pr', repo: 'org/repo', number: 9 });
    assert.deepEqual(parseGate('date:2026-10-09'), { type: 'date', date: '2026-10-09' });
    assert.deepEqual(parseGate('ticket:the-maestro-013'), { type: 'ticket', id: 'the-maestro-013' });
    for (const bad of ['', null, 'gh:pr:repo', 'date:2026-02-30', 'ticket:', 'gh:run:1', 'ticket:a b']) assert.equal(parseGate(bad), null, String(bad));
});

test('gateStatus: dates compare, lookups decide the rest, and a failed lookup is unknown', () => {
    const look = { pr: () => ({ state: 'MERGED' }), ticket: () => 'closed' };
    assert.equal(gateStatus('date:2026-10-02', '2026-10-02', look).state, 'cleared');
    assert.equal(gateStatus('date:2026-10-03', '2026-10-02', look).state, 'waiting');
    assert.equal(gateStatus('gh:pr:r#1', '2026-10-02', look).state, 'cleared');
    assert.equal(gateStatus('gh:pr:r#1', '2026-10-02', { ...look, pr: () => null }).state, 'unknown');
    assert.equal(gateStatus('ticket:t-1', '2026-10-02', { ...look, ticket: () => 'open' }).state, 'waiting');
    assert.equal(gateStatus('bogus', '2026-10-02', look).state, 'unknown');
});

test('activeDeferrals: the latest defer wins and stops hiding on its date', () => {
    const rows = [
        { kind: 'defer', defers: 'a', until: '2026-10-09' },
        { kind: 'defer', defers: 'b', until: '2026-10-05' },
        { kind: 'defer', defers: 'a', until: '2026-10-03' },
    ];
    assert.deepEqual([...activeDeferrals(rows, '2026-10-02')], [['a', '2026-10-03'], ['b', '2026-10-05']]);
    assert.deepEqual([...activeDeferrals(rows, '2026-10-03')], [['b', '2026-10-05']]);
});
