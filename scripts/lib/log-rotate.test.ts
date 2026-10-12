// Run: node --test scripts/lib/log-rotate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_MAX_BYTES, rotateLog } from './log-rotate.ts';
import { supervisorLogPath } from './supervisor-state.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'log-rotate-test-'));

test('a log under the limit, or a missing one, is left alone', () => {
  const file = join(tempDir(), 'x.log');
  assert.equal(rotateLog(file, 10), false);
  writeFileSync(file, 'short');
  assert.equal(rotateLog(file, 10), false);
  assert.equal(readFileSync(file, 'utf8'), 'short');
  assert.equal(existsSync(`${file}.1`), false);
});

test('a log over the limit is copied to .1 and emptied in place, replacing an older .1', () => {
  const file = join(tempDir(), 'x.log');
  writeFileSync(`${file}.1`, 'ancient');
  writeFileSync(file, 'a'.repeat(11));
  assert.equal(rotateLog(file, 10), true);
  assert.equal(readFileSync(`${file}.1`, 'utf8'), 'a'.repeat(11));
  assert.equal(statSync(file).size, 0);
  assert.equal(rotateLog(file, 10), false);
});

test('a writer holding the file open in append mode keeps writing at the start after a rotation', () => {
  const file = join(tempDir(), 'x.log');
  writeFileSync(file, 'b'.repeat(20));
  rotateLog(file, 10);
  appendFileSync(file, 'new\n');
  assert.equal(readFileSync(file, 'utf8'), 'new\n');
});

test('rotation never throws: an unreadable path reports false', () => {
  assert.doesNotThrow(() => rotateLog(join(tempDir(), 'no', 'such', 'x.log'), 10));
  assert.equal(LOG_MAX_BYTES, 5 * 1024 * 1024);
});

test('the supervisor log lives under the ledger root, in the project journal', () => {
  assert.equal(supervisorLogPath('/l', 'proj'), '/l/Projects/proj/Journal/Supervisor/loop-supervisor.log');
});
