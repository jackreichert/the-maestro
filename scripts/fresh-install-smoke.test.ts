import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('SIGTERM mid-run (the playbook\'s outer timeout) removes the temp dir and leaves no step running', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-signal-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fresh-install-smoke.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' }, stdio: 'ignore',
    });
    const closed = new Promise<number | null>((res) => child.on('close', (code) => res(code)));
    const smokeDirs = () => readdirSync(tmp).filter((d) => d.startsWith('maestro-smoke-'));
    for (let i = 0; i < 200 && !smokeDirs().length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(smokeDirs().length, 1, 'the smoke created its temp dir');
    child.kill('SIGTERM');
    assert.equal(await closed, 143);
    assert.deepEqual(smokeDirs(), [], 'the temp dir is gone after SIGTERM');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
