// Run: node --test scripts/lib/status-page/week.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEEK_MAX, WEEK_UNSET_LINE, readWeek, weekLines, weekStart, writeWeek } from './week.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'week-'));

test('weekStart is the Monday on or before the date', () => {
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(weekStart('2026-10-07'), '2026-10-05');
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
});

test('goals written on a Wednesday are read back all week and are stale the Monday after', () => {
  const d = dir();
  writeWeek(d, '2026-10-07', [{ text: 'Ship the widget', stream: 'Alpha' }, { text: 'Fix the gadget' }]);
  assert.match(readFileSync(join(d, 'week.md'), 'utf8'), /^date: 2026-10-05\n- Ship the widget \| Alpha\n- Fix the gadget\n$/);
  assert.deepEqual(readWeek(d, '2026-10-11'), { state: 'ok', start: '2026-10-05', items: [{ text: 'Ship the widget', stream: 'Alpha' }, { text: 'Fix the gadget' }] });
  assert.deepEqual(readWeek(d, '2026-10-12'), { state: 'stale', start: '2026-10-05' });
});

test('a missing file and an empty list read as not set and say the same line', () => {
  const d = dir();
  assert.deepEqual(readWeek(d, '2026-10-07'), { state: 'missing' });
  writeFileSync(join(d, 'week.md'), 'date: 2026-10-05\n');
  assert.equal(readWeek(d, '2026-10-07').state, 'stale');
  assert.ok(weekLines({ state: 'missing' })[0]?.startsWith(WEEK_UNSET_LINE));
});

test('writeWeek refuses no goals, a bad date and more than the cap', () => {
  const d = dir();
  assert.throws(() => writeWeek(d, '2026-10-07', []), /at least one goal/);
  assert.throws(() => writeWeek(d, 'soon', [{ text: 'x' }]), /YYYY-MM-DD/);
  assert.throws(() => writeWeek(d, '2026-10-07', Array.from({ length: WEEK_MAX + 1 }, (_, i) => ({ text: `g${i}` }))), /at most 7 goals/);
});
