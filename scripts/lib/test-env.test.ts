// Run: node --test scripts/lib/test-env.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, notifyCalls, NOTIFY_LOG_VAR } from './test-env.ts';

const LOCAL_CONFIG = new URL('../local-config.ts', import.meta.url).pathname;

/** What a script spawned with `env` resolves as its notify command and event dir, asked of the real local-config.ts. */
function resolved(env: NodeJS.ProcessEnv): { notify: string[]; eventDir: string } {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { NOTIFY_COMMAND, EVENT_DIR } from ${JSON.stringify(LOCAL_CONFIG)}; console.log(JSON.stringify({ notify: NOTIFY_COMMAND, eventDir: EVENT_DIR }));`], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { notify: string[]; eventDir: string };
}

/** A HOME whose user config names `notify` as the notify command: the trap a leaking test would walk into. */
function trapHome(notify: string): string {
  const home = mkdtempSync(join(tmpdir(), 'maestro-trap-home-'));
  mkdirSync(join(home, '.config', 'the-maestro'), { recursive: true });
  writeFileSync(join(home, '.config', 'the-maestro', 'config.md'), `\`\`\`maestro-config\nnotify_command: ["${notify}"]\n\`\`\`\n`);
  return home;
}

test('guard: a spawned script resolves the stub as its notify command, never the one in a user config', () => {
  const trap = '/real/notify-command';
  const home = trapHome(trap);
  const leaky = resolved({ PATH: process.env.PATH, HOME: home });
  assert.deepEqual(leaky.notify, [trap], 'the trap works: an inherited HOME does reach the config');
  for (const env of [cleanEnv(), cleanEnv({ HOME: home })]) {
    const { notify, eventDir } = resolved(env);
    assert.deepEqual(notify, JSON.parse(env.MAESTRO_NOTIFY_COMMAND as string));
    assert.equal(notify[0], '/bin/sh');
    assert.match(notify[1] ?? '', /maestro-test-env-.*notify-stub\.sh$/, 'the stub script is the test\'s own');
    assert.equal(eventDir, env.MAESTRO_EVENT_DIR);
  }
});

test('guard: a clean env carries no maestro setting from the outer environment', () => {
  const outer = process.env;
  const before = { ...outer };
  try {
    process.env.MAESTRO_NOTIFY_COMMAND = '["/real/notify-command"]';
    process.env.MAESTRO_LOCAL_CONFIG = '/real/config.md';
    process.env.MAESTRO_EVENT_DIR = '/real/events';
    process.env.HOME = '/real/home';
    const env = cleanEnv();
    assert.notEqual(env.MAESTRO_NOTIFY_COMMAND, '["/real/notify-command"]');
    assert.equal(env.MAESTRO_LOCAL_CONFIG, '');
    assert.notEqual(env.MAESTRO_EVENT_DIR, '/real/events');
    assert.notEqual(env.HOME, '/real/home');
    assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('MAESTRO_') || k === 'LEDGER_ROOT' || k === 'VAULT_ROOT').sort(), ['MAESTRO_EVENT_DIR', 'MAESTRO_LOCAL_CONFIG', 'MAESTRO_NOTIFY_COMMAND', NOTIFY_LOG_VAR].sort());
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
});

test('the stub records its calls, and reports none when it was not called', () => {
  const env = cleanEnv();
  assert.deepEqual(notifyCalls(env), []);
  const [cmd, ...args] = JSON.parse(env.MAESTRO_NOTIFY_COMMAND as string) as string[];
  spawnSync(cmd as string, [...args, 'maestro: x']);
  assert.deepEqual(notifyCalls(env), ['maestro: x']);
});
