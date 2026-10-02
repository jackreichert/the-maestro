// Run: node --test scripts/boxes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOX, classify, isStale, daysBetween } from './lib/boxes.mjs';

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
