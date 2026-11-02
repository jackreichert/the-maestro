// Run: node --test scripts/settings.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'settings.ts');
const dir = mkdtempSync(join(tmpdir(), 'settings-cli-'));
const file = join(dir, 'config.md');
const TEXT = '```maestro-config\nmode: full # c\nbudget_monthly_usd: 500\nslack_token: xoxb-not-real\n```\n';
writeFileSync(file, TEXT);
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: file, MAESTRO_EVENT_DIR: dir, MAESTRO_MODE: '' } });

test('list --json is grouped and never carries a secret value', () => {
  const r = run('list', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('xoxb-not-real'));
  const body = JSON.parse(r.stdout) as { groups: { name: string }[]; spend: { on: boolean } };
  assert.ok(body.groups.some((g) => g.name === 'Mode & cost'));
  assert.equal(body.spend.on, true);
});

test('list prints plain text with the group names and n/a for unknown spend', () => {
  const r = run('list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Mode & cost/);
  assert.match(r.stdout, /n\/a/);
});

test('set edits an allowlisted key and keeps a backup; a refused key exits 2 and changes nothing', () => {
  const ok = run('set', 'cost_profile', 'lean');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(file, 'utf8'), /cost_profile: lean/);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('config.md.bak-')).length, 1);
  const before = readFileSync(file, 'utf8');
  const bad = run('set', 'notify_command', 'rm -rf /');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not an editable setting/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('usage on no or unknown command', () => {
  assert.equal(run().status, 2);
  assert.equal(run('frob').status, 2);
});
