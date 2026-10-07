// Run: node --test scripts/lib/status-page/priorities.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRIORITIES_MAX, PRIORITIES_UNSET_LINE, capRefusal, formatPriorities, localDate, parsePriorities, parsePriority, readPriorities, showLines, writePriorities } from './priorities.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'prio-'));

test('parsePriority splits an optional stream suffix', () => {
  assert.deepEqual(parsePriority('Ship the thing | Alpha'), { text: 'Ship the thing', stream: 'Alpha' });
  assert.deepEqual(parsePriority('a | b | Beta'), { text: 'a | b', stream: 'Beta' });
  assert.deepEqual(parsePriority('plain   text'), { text: 'plain text' });
  assert.deepEqual(parsePriority('trailing | '), { text: 'trailing |' });
});

test('parsePriorities reads the date and bullets, numbered items and checkboxes; ignores the rest', () => {
  const r = parsePriorities('# note\ndate: 2026-10-05\n- one | Alpha\n2. two\n* [ ] three\nnot an item\n');
  assert.equal(r.date, '2026-10-05');
  assert.deepEqual(r.items, [{ text: 'one', stream: 'Alpha' }, { text: 'two' }, { text: 'three' }]);
  assert.equal(parsePriorities('date: tomorrow\n- x').date, '');
});

test('write then read round-trips for today', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'a', stream: 'S' }, { text: 'b' }]);
  assert.equal(readFileSync(join(d, 'priorities.md'), 'utf8'), formatPriorities('2026-10-05', [{ text: 'a', stream: 'S' }, { text: 'b' }]));
  const s = readPriorities(d, '2026-10-05');
  assert.deepEqual(s, { state: 'ok', date: '2026-10-05', items: [{ text: 'a', stream: 'S' }, { text: 'b' }] });
});

test('a missing file, another day and an empty list all read as not set, and say the same line', () => {
  const d = dir();
  assert.deepEqual(readPriorities(d, '2026-10-05'), { state: 'missing' });
  writePriorities(d, '2026-10-04', [{ text: 'old' }]);
  assert.deepEqual(readPriorities(d, '2026-10-05'), { state: 'stale', date: '2026-10-04' });
  writeFileSync(join(d, 'priorities.md'), 'date: 2026-10-05\n');
  assert.equal(readPriorities(d, '2026-10-05').state, 'stale');
  assert.ok(showLines({ state: 'missing' })[0]?.startsWith(PRIORITIES_UNSET_LINE));
  assert.ok(showLines({ state: 'stale', date: '2026-10-04' })[0]?.startsWith(PRIORITIES_UNSET_LINE));
});

test('writePriorities refuses an empty list and a bad date, leaving the old file alone', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'keep' }]);
  assert.throws(() => writePriorities(d, '2026-10-05', []), /at least one/);
  assert.throws(() => writePriorities(d, '10/05', [{ text: 'x' }]), /YYYY-MM-DD/);
  assert.equal(readPriorities(d, '2026-10-05').state, 'ok');
});

test('localDate follows the zone, not UTC', () => {
  const late = new Date('2026-10-06T02:30:00Z');
  assert.equal(localDate(late, 'America/New_York'), '2026-10-05');
  assert.equal(localDate(late, 'UTC'), '2026-10-06');
});

test('capRefusal names the cap and how many to drop, and is null at or under it', () => {
  assert.equal(DEFAULT_PRIORITIES_MAX, 5);
  assert.equal(capRefusal(5, 5), null);
  assert.equal(capRefusal(0, 5), null);
  assert.match(capRefusal(6, 5) ?? '', /at most 5 priorities \(priorities_max\); got 6: drop 1/);
});

test('writePriorities refuses a list over the cap and leaves the file alone', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'keep' }], 2);
  const before = readFileSync(join(d, 'priorities.md'), 'utf8');
  assert.throws(() => writePriorities(d, '2026-10-05', [{ text: 'a' }, { text: 'b' }, { text: 'c' }], 2), /at most 2 priorities/);
  assert.equal(readFileSync(join(d, 'priorities.md'), 'utf8'), before);
  writePriorities(d, '2026-10-05', [{ text: 'a' }, { text: 'b' }], 2);
});
