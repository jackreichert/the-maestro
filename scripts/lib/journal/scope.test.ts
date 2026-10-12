// Run: node --test scripts/lib/journal/scope.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerRow } from '../ledger-core.ts';
import { bindsHere, parseRuleScope, ruleFooter, ruleLines, rulesInForce } from './scope.ts';

const row = (id: string, ruleScope: LedgerRow['ruleScope'], window: string, over: Partial<LedgerRow> = {}): LedgerRow => ({ id, kind: 'decision', text: `rule ${id}`, ruleScope, window, ...over });

test('bindsHere: a window-scoped row binds only its window; global and unscoped rows bind all', () => {
    assert.equal(bindsHere(row('a', 'window', 'A'), 'A'), true);
    assert.equal(bindsHere(row('a', 'window', 'A'), 'B'), false);
    assert.equal(bindsHere(row('b', 'global', 'A'), 'B'), true);
    assert.equal(bindsHere(row('c', undefined, 'A'), 'B'), true);
});

test('rulesInForce skips pending decisions and kinds that are not rules', () => {
    const rows = [row('a', 'window', 'A'), row('p', 'window', 'A', { pending: true }), row('w', 'window', 'A', { kind: 'wip' })];
    assert.deepEqual(rulesInForce(rows, 'A').here.map((r) => r.id), ['a']);
    assert.equal(rulesInForce(rows, 'B').elsewhere, 1);
});

test('ruleLines keeps the newest few and counts the rest; ruleFooter is empty with nothing scoped', () => {
    const rows = ['1', '2', '3', '4'].map((n) => row(n, 'global', 'A'));
    const lines = ruleLines(rows, 'A', 2);
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /\+2 older/);
    assert.match(lines[2] ?? '', /^Rule 4 \(global\)/);
    assert.equal(ruleFooter([row('x', undefined, 'A')], 'A'), '');
    assert.deepEqual(ruleLines([], 'A'), []);
});

test('parseRuleScope accepts window and global on a decision or note only', () => {
    assert.deepEqual(parseRuleScope('window', 'note'), { scope: 'window' });
    assert.ok('error' in parseRuleScope('window', 'wip'));
    assert.ok('error' in parseRuleScope(null, 'note'));
});

const H = 3_600_000;
const at = (hoursAfter: number): number => Date.parse('2026-10-12T00:00:00Z') + hoursAfter * H;
const stamped = (r: LedgerRow, hoursAfter: number): LedgerRow => ({ ...r, ts: new Date(at(hoursAfter)).toISOString() });

test('a window-scoped rule stops binding once its window has been silent for over 24 hours; a global one never expires', () => {
    const rows = [stamped(row('w', 'window', 'A'), 0), stamped(row('g', 'global', 'A'), 0)];
    assert.deepEqual(rulesInForce(rows, 'A', at(23)).here.map((r) => r.id), ['w', 'g']);
    assert.deepEqual(rulesInForce(rows, 'A', at(25)).here.map((r) => r.id), ['g']);
    assert.equal(rulesInForce(rows, 'B', at(25)).elsewhere, 0, 'an expired rule is not even an FYI');
    assert.equal(rulesInForce(rows, 'B', at(23)).elsewhere, 1);
});

test('any later row from the window keeps its scoped rules alive', () => {
    const rows = [stamped(row('w', 'window', 'A'), 0), stamped({ id: 'n', kind: 'wip', window: 'A', text: 'later work' }, 30)];
    assert.deepEqual(rulesInForce(rows, 'A', at(40)).here.map((r) => r.id), ['w']);
});

test('a rule closed by a drop or a resolve is not in force', () => {
    const rows = [row('w', 'window', 'A'), row('g', 'global', 'A'), { id: 'x', kind: 'dropped', closes: 'w', window: 'A' }, { id: 'y', kind: 'resolved', closes: 'g', window: 'A' }];
    assert.deepEqual(rulesInForce(rows, 'A').here, []);
    assert.equal(rulesInForce(rows, 'B').elsewhere, 0);
});
