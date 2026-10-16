import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footerOneLine } from './footer-line.ts';

const row = (o: object) => ({ name: null, done: 0, inflight: 0, queued: 0, awaiting: 0, paste: 0, blocked: 0, ...o });
const ok = { available: true, turns: 86, ctxK: 96, triggerK: 200, pct: 48, readK: 129, advice: '' } as const;

test('footerOneLine sums the streams and drops empty parts', () => {
    const rows = [row({ name: 'A', done: 3, inflight: 1, awaiting: 1 }), row({ name: 'B', done: 1, inflight: 1, blocked: 2, paste: 1 })];
    assert.equal(footerOneLine({ rows, session: ok }), 'Ledger: 4 done today · 2 in flight · 1 awaiting · 1 to run · 2 blocked | Session: 86 turns · 96k/200k (48%) · 129k/turn');
});

test('footerOneLine strips markup from the queue and loop lines and carries the roll advice', () => {
    const line = footerOneLine({ rows: [row({})], queue: '**Review queue:** 2 of 4', loop: '**Loop:** running', session: { ...ok, advice: 'roll soon' } });
    assert.equal(line, 'Ledger: 0 done today · 0 in flight · 0 awaiting | Review queue: 2 of 4 | Loop: running | Session: 86 turns · 96k/200k (48%) · 129k/turn · roll soon');
    assert.doesNotMatch(line, /\*|\n/);
});

test('footerOneLine says when the session is unavailable', () => {
    assert.match(footerOneLine({ rows: [row({})], session: { available: false, unavailable: 'no session x in /d' } }), /Session: unavailable \(no session x in \/d\)$/);
});

test('footerOneLine shows the stale count beside the in-flight count, not inside it', () => {
    const rows = [row({ name: 'A', inflight: 3, stale: 2 }), row({ name: 'B', inflight: 1, stale: 1 })];
    assert.match(footerOneLine({ rows, session: ok }), /^Ledger: 0 done today · 4 in flight · 3 stale · 0 awaiting/);
});

test('footerOneLine names the session by its short id when the status carries one, so two open sessions are told apart', () => {
    assert.match(footerOneLine({ rows: [row({})], session: { ...ok, session: '31a43ae4' } }), /Session: 31a43ae4 · 86 turns · 96k\/200k \(48%\)/);
});
