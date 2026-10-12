import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { toolCommand } from './tool-bin.ts';
import { stubEnv, writeStub } from './stub-bin.ts';

const dir = mkdtempSync(join(tmpdir(), 'stub-bin-test-'));
const runThroughSeam = (varName: string, tool: string, stub: ReturnType<typeof writeStub>, args: string[], extraEnv: Record<string, string> = {}) => {
  const env = { ...process.env, ...stubEnv(varName, stub), ...extraEnv };
  return spawnSync(...toolCommand(tool, args, env), { encoding: 'utf8', env });
};

test('a node stub runs with its arguments and env, and its exit code and output come back', () => {
  const stub = writeStub(join(dir, 'gh.cjs'), `#!${process.execPath}\nconsole.log(process.argv.slice(2).join('|'), process.env.STUB_X);\nconsole.error('err');\nprocess.exit(3);\n`);
  const r = runThroughSeam('MAESTRO_GH_BIN', 'gh', stub, ['pr', 'view'], { STUB_X: 'x1' });
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr.trim()], [3, 'pr|view x1', 'err']);
});

test('sh and bash stubs run, and arguments with spaces and quotes arrive intact', () => {
  for (const interp of ['/bin/sh', '/bin/bash']) {
    const stub = writeStub(join(dir, `s-${interp.slice(5)}`), `#!${interp}\nprintf '%s|' "$@"\n`);
    assert.equal(runThroughSeam('MAESTRO_GIT_BIN', 'git', stub, ['a b', "it's", '']).stdout, "a b|it's||");
  }
});

test('the written script is not executable, so nothing a test writes is ever exec-ed', () => {
  const stub = writeStub(join(dir, 'tool'), '#!/bin/sh\nexit 0\n');
  assert.equal(statSync(stub.script).mode & 0o111, 0);
  assert.deepEqual([stub.bin, stub.args], ['/bin/sh', [stub.script]]);
});

test('a stub whose interpreter is not one already on the machine, or that has arguments or no shebang, is refused', () => {
  for (const body of ['echo hi\n', '#!/usr/bin/env node\n', '#!/bin/sh -e\n', '#!/tmp/anything\n', '#!/bin/sh']) {
    assert.throws(() => writeStub(join(dir, 'bad'), body), /first line must be/);
  }
});
