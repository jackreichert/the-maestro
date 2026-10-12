import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('SIGTERM mid-run (the playbook\'s outer timeout) removes the temp dir and kills the running step', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-signal-'));
  try {
    // A `git` that records its pid and hangs holds the Quick start's clone step open, whatever the machine or checkout looks like.
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const pidfile = join(tmp, 'git.pid');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ > '${pidfile}'\nexec sleep 300\n`, { mode: 0o755 });
    const scratch = join(tmp, 'tmpdir');
    mkdirSync(scratch);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fresh-install-smoke.ts', import.meta.url))], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, TMPDIR: scratch, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' }, stdio: 'ignore',
    });
    const closed = new Promise<number | null>((res) => child.on('close', (code) => res(code)));
    for (let i = 0; i < 200 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(pidfile), 'the clone step started');
    const stepPid = Number(readFileSync(pidfile, 'utf8').trim());
    assert.equal(readdirSync(scratch).filter((d) => d.startsWith('maestro-smoke-')).length, 1, 'the smoke created its temp dir');
    child.kill('SIGTERM');
    assert.equal(await closed, 143);
    assert.deepEqual(readdirSync(scratch), [], 'the temp dir is gone after SIGTERM');
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(stepPid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the running step was killed with the smoke');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
