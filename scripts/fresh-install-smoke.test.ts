import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quickStartBlock, rewrite } from './fresh-install-smoke.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the real README Quick start block carries a clone line and the vault placeholder', () => {
  const out = rewrite(quickStartBlock(readme), '/src/repo', '/tmp/v');
  assert.match(out, /git clone \/src\/repo ~\/\.claude\/skills\/the-maestro/);
  assert.match(out, /export VAULT_ROOT="\/tmp\/v"/);
});

test('--remote keeps the clone URL', () => {
  assert.match(rewrite(quickStartBlock(readme), null, '/tmp/v'), /git clone https:\/\/github\.com\/jackreichert\/the-maestro /);
});

test('a Quick start that lost its clone line or placeholder is refused', () => {
  assert.throws(() => rewrite('echo hi\nexport VAULT_ROOT="/absolute/path/to/your/vault"', '/s', '/v'), /git clone/);
  assert.throws(() => rewrite('git clone x y', '/s', '/v'), /placeholder/);
  assert.throws(() => quickStartBlock('# no section'), /Quick start/);
});
