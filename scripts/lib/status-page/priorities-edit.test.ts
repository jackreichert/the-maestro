// Run: node --test scripts/lib/status-page/priorities-edit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditRefused, checkPriority, editPriorities } from './priorities-edit.ts';

const TODAY = '2026-10-07';
const dir = (text?: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'prio-edit-'));
  if (text !== undefined) writeFileSync(join(d, 'priorities.md'), text);
  return d;
};
const read = (d: string): string => readFileSync(join(d, 'priorities.md'), 'utf8');
const texts = (r: { items: { text: string }[] }): string[] => r.items.map((i) => i.text);
const refused = (code: string) => (e: unknown): boolean => e instanceof EditRefused && e.code === code;
const opts = { max: 5 };

test('move reorders in place and keeps every line the editor does not own', () => {
  const d = dir('# my list\ndate: 2026-10-07\n- one | Alpha\n<!-- keep me -->\n- two\n- three | Beta\n\ntrailing prose\n');
  const r = editPriorities(d, TODAY, { op: 'move', from: 2, to: 0, text: 'three' }, opts);
  assert.deepEqual(texts(r), ['three', 'one', 'two']);
  assert.equal(read(d), '# my list\ndate: 2026-10-07\n- three | Beta\n<!-- keep me -->\n- one | Alpha\n- two\n\ntrailing prose\n');
});

test('numbered lists are renumbered, bullets and checkboxes travel with their item', () => {
  const d = dir('date: 2026-10-07\n1. a\n2. b | S\n3. c\n');
  editPriorities(d, TODAY, { op: 'move', from: 2, to: 0, text: 'c' }, opts);
  assert.equal(read(d), 'date: 2026-10-07\n1. c\n2. a\n3. b | S\n');
  const e = dir('date: 2026-10-07\n* [ ] a\n* [x] b\n');
  editPriorities(e, TODAY, { op: 'move', from: 1, to: 0, text: 'b' }, opts);
  assert.equal(read(e), 'date: 2026-10-07\n* [x] b\n* [ ] a\n');
});

test('delete removes only that line', () => {
  const d = dir('date: 2026-10-07\n- one\n- two\n- three\n');
  const r = editPriorities(d, TODAY, { op: 'delete', index: 1, text: 'two' }, opts);
  assert.deepEqual(texts(r), ['one', 'three']);
  assert.equal(read(d), 'date: 2026-10-07\n- one\n- three\n');
  editPriorities(d, TODAY, { op: 'delete', index: 0, text: 'one' }, opts);
  editPriorities(d, TODAY, { op: 'delete', index: 0, text: 'three' }, opts);
  assert.equal(read(d), 'date: 2026-10-07\n', 'the last one can go; the file stays a valid empty list');
});

test('add appends in the file own style and stops at the cap with a remove-one-first message', () => {
  const d = dir('date: 2026-10-07\n1. a\n2. b\n');
  const r = editPriorities(d, TODAY, { op: 'add', text: 'c', stream: 'Alpha' }, { max: 3 });
  assert.equal(read(d), 'date: 2026-10-07\n1. a\n2. b\n3. c | Alpha\n');
  assert.equal(r.over, false);
  const before = read(d);
  assert.throws(() => editPriorities(d, TODAY, { op: 'add', text: 'd' }, { max: 3 }), (e) => refused('cap')(e) && /remove one first/.test((e as Error).message) && /3 of 3/.test((e as Error).message));
  assert.equal(read(d), before);
});

test('a list already over the cap is grandfathered: reorder and delete work, add stays blocked until it fits', () => {
  const six = 'date: 2026-10-07\n- a\n- b\n- c\n- d\n- e\n- f\n';
  const d = dir(six);
  assert.equal(editPriorities(d, TODAY, { op: 'move', from: 5, to: 0, text: 'f' }, opts).over, true);
  assert.throws(() => editPriorities(d, TODAY, { op: 'add', text: 'g' }, opts), refused('cap'));
  assert.equal(editPriorities(d, TODAY, { op: 'delete', index: 0, text: 'f' }, opts).over, false, 'six minus one is at the cap');
  assert.throws(() => editPriorities(d, TODAY, { op: 'add', text: 'g' }, opts), refused('cap'), 'at the cap, still full');
  editPriorities(d, TODAY, { op: 'delete', index: 0, text: 'a' }, opts);
  assert.deepEqual(texts(editPriorities(d, TODAY, { op: 'add', text: 'g' }, opts)), ['b', 'c', 'd', 'e', 'g']);
});

test('a missing or stale file starts today list on add; move and delete have nothing to act on', () => {
  const none = dir();
  assert.equal(editPriorities(none, TODAY, { op: 'add', text: 'first' }, opts).items.length, 1);
  assert.equal(read(none), 'date: 2026-10-07\n- first\n');
  const stale = dir('# old\ndate: 2026-10-06\n- yesterday\n');
  assert.throws(() => editPriorities(stale, TODAY, { op: 'delete', index: 0, text: 'yesterday' }, opts), refused('conflict'));
  editPriorities(stale, TODAY, { op: 'add', text: 'today thing' }, opts);
  assert.equal(read(stale), '# old\ndate: 2026-10-07\n- today thing\n');
});

test('an edit made by hand since the page was drawn is a conflict, not a silent overwrite', () => {
  const d = dir('date: 2026-10-07\n- one\n- two\n');
  writeFileSync(join(d, 'priorities.md'), 'date: 2026-10-07\n- two\n- one\n- hand added\n');
  assert.throws(() => editPriorities(d, TODAY, { op: 'delete', index: 0, text: 'one' }, opts), refused('conflict'));
  assert.equal(read(d), 'date: 2026-10-07\n- two\n- one\n- hand added\n', 'nothing was written');
  assert.throws(() => editPriorities(d, TODAY, { op: 'move', from: 9, to: 0, text: 'x' }, opts), refused('conflict'));
});

test('a hand edit that lands between the read and the rename is kept: the edit re-reads and re-applies', () => {
  const d = dir('date: 2026-10-07\n- one\n- two\n');
  let raced = false;
  const r = editPriorities(d, TODAY, { op: 'add', text: 'three' }, { max: 9, afterRead: () => {
    if (raced) return;
    raced = true;
    writeFileSync(join(d, 'priorities.md'), 'date: 2026-10-07\n# edited while the page was saving\n- one\n- two\n- hand added\n');
  } });
  assert.deepEqual(texts(r), ['one', 'two', 'hand added', 'three']);
  assert.match(read(d), /# edited while the page was saving/);
});

test('an edit that keeps losing the race gives up as busy and writes nothing', () => {
  const d = dir('date: 2026-10-07\n- one\n');
  let n = 0;
  assert.throws(() => editPriorities(d, TODAY, { op: 'add', text: 'x' }, { max: 9, afterRead: () => { n += 1; writeFileSync(join(d, 'priorities.md'), `date: 2026-10-07\n- one\n- race ${n}\n`); } }), refused('busy'));
  assert.doesNotMatch(read(d), /- x/);
});

test('the write is a temp file and a rename: no temp file is left, the mode is kept, a symlink is followed', () => {
  const d = dir('date: 2026-10-07\n- one\n- two\n');
  chmodSync(join(d, 'priorities.md'), 0o600);
  editPriorities(d, TODAY, { op: 'move', from: 1, to: 0, text: 'two' }, opts);
  assert.deepEqual(readdirSync(d), ['priorities.md']);
  assert.equal(statSync(join(d, 'priorities.md')).mode & 0o777, 0o600);
  const real = dir('date: 2026-10-07\n- one\n');
  const link = dir();
  symlinkSync(join(real, 'priorities.md'), join(link, 'priorities.md'));
  editPriorities(link, TODAY, { op: 'add', text: 'two' }, opts);
  assert.match(read(real), /- two/);
});

test('checkPriority normalises and refuses text that would not survive the file or would render as markup', () => {
  assert.deepEqual(checkPriority('  ship   it ', 'Alpha'), { text: 'ship it', stream: 'Alpha' });
  assert.deepEqual(checkPriority('plain', undefined), { text: 'plain' });
  for (const bad of ['', '   ', 'x'.repeat(201), 'two\nlines', 'tab\there', '<b>bold</b>', 'a | b', '[ ] box', '[x] box', 'bell\u0007'])
    assert.throws(() => checkPriority(bad, undefined), refused('invalid'), JSON.stringify(bad));
  for (const bad of ['', 'x'.repeat(41), 'a | b', '<s>', 'new\nline', ' lead'])
    assert.throws(() => checkPriority('ok', bad), refused('invalid'), JSON.stringify(bad));
});
