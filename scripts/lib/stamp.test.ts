// Run: node --test scripts/lib/stamp.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stamp, stampAll } from './stamp.ts';

const dir = mkdtempSync(join(tmpdir(), 'stamp-'));

test('stamp is mtime:size, and "-" for a file that does not exist', () => {
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'abc');
  utimesSync(f, 1000, 1000);
  assert.equal(stamp(f), '1000000:3');
  assert.equal(stamp(join(dir, 'missing')), '-');
});

test('stamp changes on a same-size rewrite with a new mtime, and when a missing file appears', () => {
  const f = join(dir, 'b.txt');
  assert.equal(stamp(f), '-');
  writeFileSync(f, 'xx');
  utimesSync(f, 1000, 1000);
  const first = stamp(f);
  assert.notEqual(first, '-');
  writeFileSync(f, 'yy');
  utimesSync(f, 2000, 2000);
  assert.notEqual(stamp(f), first);
});

test('stampAll joins the stamps in order with "|" and changes when any file does', () => {
  const a = join(dir, 'c.txt');
  const b = join(dir, 'd.txt');
  writeFileSync(a, '1');
  utimesSync(a, 1000, 1000);
  assert.equal(stampAll([a, b]), '1000000:1|-');
  writeFileSync(b, '22');
  utimesSync(b, 3000, 3000);
  assert.equal(stampAll([a, b]), '1000000:1|3000000:2');
  assert.equal(stampAll([]), '');
});
