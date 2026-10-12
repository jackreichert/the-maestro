import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overrideCommand, toolCommand } from './tool-bin.ts';

test('with no override the tool is called by name with its own arguments, and the ARGS variable is not read', () => {
  assert.deepEqual(toolCommand('gh', ['pr', 'view'], {}), ['gh', ['pr', 'view']]);
  assert.deepEqual(toolCommand('gh', ['x'], { MAESTRO_GH_BIN_ARGS: 'not json' }), ['gh', ['x']]);
  assert.deepEqual(toolCommand('gh', ['x'], { MAESTRO_GH_BIN: '' }), ['gh', ['x']]);
  assert.deepEqual(toolCommand('npm', ['ci'], { MAESTRO_GH_BIN: '/bin/sh' }), ['npm', ['ci']]);
});

test('an override runs the binary with the JSON leading arguments first, byte for byte', () => {
  const env = { MAESTRO_GH_BIN: '/bin/sh', MAESTRO_GH_BIN_ARGS: JSON.stringify(['/tmp/a b/stub.cjs', "it's $HOME *"]) };
  assert.deepEqual(toolCommand('gh', ['pr', ''], env), ['/bin/sh', ['/tmp/a b/stub.cjs', "it's $HOME *", 'pr', '']]);
  assert.deepEqual(toolCommand('git', ['status'], { MAESTRO_GIT_BIN: '/bin/bash' }), ['/bin/bash', ['status']]);
  assert.deepEqual(overrideCommand('MAESTRO_LOOP_BIN', '', ['run'], { MAESTRO_LOOP_BIN: '/bin/sh', MAESTRO_LOOP_BIN_ARGS: '["s.sh"]' }), ['/bin/sh', ['s.sh', 'run']]);
});

test('a malformed ARGS value fails loudly instead of being split or ignored', () => {
  for (const raw of ['/tmp/stub.cjs', '{"a":1}', '[1]', '["ok", null]', '']) {
    if (raw === '') { assert.deepEqual(toolCommand('gh', [], { MAESTRO_GH_BIN: '/bin/sh', MAESTRO_GH_BIN_ARGS: raw }), ['/bin/sh', []]); continue; }
    assert.throws(() => toolCommand('gh', [], { MAESTRO_GH_BIN: '/bin/sh', MAESTRO_GH_BIN_ARGS: raw }), /MAESTRO_GH_BIN_ARGS must be a JSON array of strings/);
  }
});
