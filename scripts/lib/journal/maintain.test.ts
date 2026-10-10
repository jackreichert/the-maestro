// Run: node --test scripts/lib/journal/maintain.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBefore, maintainLine, parseMaintainLine } from './maintain.ts';

test('daysBefore lists the days before today, newest first, across a month and a year boundary', () => {
    assert.deepEqual(daysBefore('2026-03-02', 3), ['2026-03-01', '2026-02-28', '2026-02-27']);
    assert.deepEqual(daysBefore('2026-01-01', 2), ['2025-12-31', '2025-12-30']);
    assert.equal(daysBefore('2026-10-09').length, 7);
});

test('daysBefore returns nothing for a malformed day', () => {
    assert.deepEqual(daysBefore('yesterday'), []);
    assert.deepEqual(daysBefore('2026-13-45'), []);
});

test('the result line round-trips, and the last one in the output wins', () => {
    const a = { ok: false, archivedDays: ['2026-10-08'], sweep: null, problems: ['x'] };
    const b = { ok: true, archivedDays: [], sweep: { removed: 1, pruned: 0, kept: 2, skipped: 0, failed: 0 }, problems: [] };
    assert.deepEqual(parseMaintainLine(`noise\n${maintainLine(a)}\n${maintainLine(b)}\n`), b);
    assert.deepEqual(parseMaintainLine(maintainLine(a)), a);
});

test('output with no valid result line is null', () => {
    assert.equal(parseMaintainLine('archived 1 finished item(s)\n'), null);
    assert.equal(parseMaintainLine('maintain-result {not json'), null);
    assert.equal(parseMaintainLine('maintain-result {"ok":"yes"}'), null);
});
