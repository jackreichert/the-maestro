import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandScript, parseLaunch, shellQuote } from './wake-terminal.ts';

test('the prompt is the one positional argument; cwd and claude may be set', () => {
  assert.deepEqual(parseLaunch(['--cwd', '/work', '--claude', '/bin/claude', 'hello'], '/default'), { cwd: '/work', claude: '/bin/claude', prompt: 'hello' });
  assert.deepEqual(parseLaunch(['hello'], '/default'), { cwd: '/default', claude: 'claude', prompt: 'hello' });
});

test('every permission flag is refused, in either position and either spelling', () => {
  for (const flag of ['--dangerously-skip-permissions', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools']) {
    assert.throws(() => parseLaunch([flag, 'plan', 'p'], '/d'), /refusing/, flag);
    assert.throws(() => parseLaunch(['p', `${flag}=x`], '/d'), /refusing/, flag);
  }
});

test('unknown options, a missing value, and zero or several prompts are refused', () => {
  assert.throws(() => parseLaunch(['--model', 'x', 'p'], '/d'), /unknown option/);
  assert.throws(() => parseLaunch(['--cwd'], '/d'), /needs a value/);
  assert.throws(() => parseLaunch([], '/d'), /Usage/);
  assert.throws(() => parseLaunch(['a', 'b'], '/d'), /Usage/);
});

test('the script quotes everything, so a hostile prompt or path stays one word', () => {
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`);
  const script = commandScript({ cwd: `/x'; rm -rf ~; '`, claude: 'claude', prompt: `$(touch /tmp/pwn) \`id\` "q"` });
  assert.match(script, /^#!\/bin\/zsh\ncd '\/x'\\''; rm -rf ~; '\\'''/);
  assert.match(script, /exec 'claude' '\$\(touch \/tmp\/pwn\) `id` "q"'\n$/);
});
