import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quickStartBlock, rewrite } from './fresh-install-smoke.ts';
import { waitForPidFile } from './lib/test-env.ts';

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
    // It is a shell function sourced through SMOKE_BASH_ENV, which the smoke hands to its steps as BASH_ENV (the step runs `bash -c`), so no executable is written for the machine to scan.
    const pidfile = join(tmp, 'git.pid');
    const hangingGit = join(tmp, 'hanging-git.sh');
    writeFileSync(hangingGit, `git() { echo $$ > '${pidfile}'; exec sleep 300; }\n`);
    const scratch = join(tmp, 'tmpdir');
    mkdirSync(scratch);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fresh-install-smoke.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, SMOKE_BASH_ENV: hangingGit, HOME: tmp, TMPDIR: scratch, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' }, stdio: 'ignore',
    });
    const closed = new Promise<number | null>((res) => child.on('close', (code) => res(code)));
    // Deadlines are generous on purpose: a loaded machine can stall a fresh bash or node start for many seconds, and a pass never waits for them.
    const until = async (done: () => boolean, ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end && !done(); ) await new Promise((r) => setTimeout(r, 50));
      return done();
    };
    const stepPid = await waitForPidFile(pidfile, 60_000);
    assert.ok(stepPid, 'the clone step started and recorded its pid');
    assert.equal(readdirSync(scratch).filter((d) => d.startsWith('maestro-smoke-')).length, 1, 'the smoke created its temp dir');
    child.kill('SIGTERM');
    assert.equal(await closed, 143);
    assert.deepEqual(readdirSync(scratch), [], 'the temp dir is gone after SIGTERM');
    const gone = (): boolean => { try { process.kill(stepPid, 0); return false; } catch { return true; } };
    assert.equal(await until(gone, 30_000), true, 'the running step was killed with the smoke');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
