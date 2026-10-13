// Run: node --test scripts/lib/cost-registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRegistryRow, experimentId, parseRegistry } from './cost-registry.ts';
import type { RegistryRow } from './cost-registry.ts';

const NOTE = [
  '# Strategies', '', 'Intro text with a | pipe outside the table.', '',
  '| Id | Practice | Hypothesis | Metric | Success threshold | Start | Status | Result |',
  '|---|---|---|---|---|---|---|---|',
  '| A | Foreground waits | fewer wakes | Wakes/prompt | at most 0.5 | 2026-09-20 | adopted | -40% wakes |',
  '| B | Haiku sweeps | cheaper | Haiku share | at least 15% | 2026-09-21 | running | - |',
  '', 'Text after the table.',
].join('\n');

const row = (id: string): RegistryRow => ({ id, practice: 'Cap reports', hypothesis: 'shorter reports', metric: 'Avg report', threshold: 'at most 1.5k', start: '2026-10-13', status: 'proposed', result: '-' });

test('parseRegistry reads each row of the table by column and ignores the text around it', () => {
  const rows = parseRegistry(NOTE);
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.metric]), [['A', 'adopted', 'Wakes/prompt'], ['B', 'running', 'Haiku share']]);
  assert.equal(rows[0]?.result, '-40% wakes');
});

test('parseRegistry gives no rows for a note with no registry table', () => {
  assert.deepEqual(parseRegistry('# Nothing here\n\n| a | b |\n|---|---|\n| 1 | 2 |'), []);
});

test('addRegistryRow adds the row after the last one, and a second add with the same id changes nothing', () => {
  const once = addRegistryRow(NOTE, row(experimentId('2026-10-13')));
  assert.ok(once);
  assert.deepEqual(parseRegistry(once).map((r) => r.id), ['A', 'B', 'cx-2026-10-13']);
  assert.ok(once.endsWith('Text after the table.'), 'the text after the table is untouched');
  assert.equal(addRegistryRow(once, { ...row('cx-2026-10-13'), practice: 'a different proposal' }), once, 'one row per day');
});

test('addRegistryRow keeps a cell on one line without a pipe, so the table cannot be split', () => {
  const out = addRegistryRow(NOTE, { ...row('cx-2026-10-14'), hypothesis: 'a | b\nc' });
  assert.equal(parseRegistry(out ?? '').find((r) => r.id === 'cx-2026-10-14')?.hypothesis, 'a / b c');
});

test('addRegistryRow refuses a note with no registry table instead of writing one blind', () => {
  assert.equal(addRegistryRow('# no table', row('cx-2026-10-13')), null);
});

test('a hand-edited row too short to parse still counts as the day\'s row', () => {
  const broken = NOTE.replace('| B |', '| cx-2026-10-13 | short |\n| B |');
  assert.equal(addRegistryRow(broken, row('cx-2026-10-13')), broken);
});
