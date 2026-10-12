import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { writeStub } from './stub-bin.ts';

const dir = mkdtempSync(join(tmpdir(), 'stub-bin-test-'));

test('a node stub runs with its arguments and env, and its exit code and output come back', () => {
  const gh = writeStub(join(dir, 'gh'), `#!${process.execPath}\nconsole.log(process.argv.slice(2).join('|'), process.env.STUB_X);\nconsole.error('err');\nprocess.exit(3);\n`);
  const r = spawnSync(gh, ['pr', 'view'], { encoding: 'utf8', env: { ...process.env, STUB_X: 'x1' } });
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr.trim()], [3, 'pr|view x1', 'err']);
});

test('a sh stub runs, and is found by name on PATH', () => {
  writeStub(join(dir, 'fakegit'), '#!/bin/sh\necho "got $1 $2"\n');
  const r = spawnSync('fakegit', ['a', 'b c'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.stdout.trim(), 'got a b c');
});

test('the stub path is a symlink to the committed runner and the written script is not executable, so no new executable is ever run', () => {
  const p = writeStub(join(dir, 'tool'), '#!/bin/sh\nexit 0\n');
  assert.ok(lstatSync(p).isSymbolicLink());
  assert.match(readlinkSync(p), /stub-runner\.sh$/);
  assert.equal(statSync(`${p}.stub`).mode & 0o111, 0);
  assert.notEqual(statSync(readlinkSync(p)).mode & 0o111, 0);
});

test('writing the same path again replaces the stub, and a body without a plain shebang is refused', () => {
  const p = join(dir, 'again');
  writeStub(p, '#!/bin/sh\necho one\n');
  writeStub(p, '#!/bin/sh\necho two\n');
  assert.equal(spawnSync(p, { encoding: 'utf8' }).stdout.trim(), 'two');
  assert.throws(() => writeStub(join(dir, 'bad'), 'echo hi\n'), /shebang|interpreter/);
  assert.throws(() => writeStub(join(dir, 'bad2'), '#!/usr/bin/env node\n'), /interpreter/);
});
