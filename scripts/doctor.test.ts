import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snippet } from './hooks/print-settings-snippet.ts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'doctor.ts');
const home = mkdtempSync(join(tmpdir(), 'doctor-home-'));
const run = (...args: string[]) => spawnSync('node', [SCRIPT, ...args], {
  encoding: 'utf8', cwd: home, env: { ...process.env, HOME: home, MAESTRO_LOCAL_CONFIG: '', MAESTRO_OVERLAY: '', MAESTRO_RUNTIME_WORKTREE: home },
});
const digest = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

test('a settings file with every snippet hook registered passes the registration check and is left byte-identical', () => {
  const file = join(home, 'full.json');
  writeFileSync(file, JSON.stringify(snippet([])));
  const before = digest(file);
  const r = run('--settings', file, '--json');
  const results = (JSON.parse(r.stdout) as { results: { name: string; status: string; detail: string }[] }).results;
  const reg = results.find((c) => c.name === 'hooks registered');
  assert.equal(reg?.status, 'ok');
  assert.match(reg?.detail ?? '', /all [1-9]\d* hook scripts/, 'a non-empty expected list, so a broken extraction cannot pass');
  assert.equal(digest(file), before, 'doctor never writes the settings file');
  assert.deepEqual(readdirSync(home).sort(), ['full.json'], 'and creates nothing beside it');
});

test('an empty settings file reports the missing guards by name, exits 1 and says nothing was changed', () => {
  const file = join(home, 'empty.json');
  writeFileSync(file, '{"env":{"TOKEN":"sk-not-a-real-secret"}}');
  const r = run('--settings', file);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not registered in .*empty\.json: .*git-guard\.ts/);
  assert.match(r.stdout, /agent-dispatch\.ts/);
  assert.match(r.stdout, /Nothing was changed\./);
  assert.doesNotMatch(r.stdout + r.stderr, /sk-not-a-real-secret/);
});

test('an unknown flag is a usage error', () => {
  assert.equal(run('--fix').status, 2);
});
