// Run: node --test scripts/lib/settings-write.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED, setSetting } from './settings-write.ts';

const NOW = new Date('2026-11-05T13:04:05Z');
const TEXT = '# my config\n\nProse stays.\n\n```maestro-config\nmode: full   # keep this comment\nnotify_command: say hi\nwatch_quiet_hours: 20:00-07:00\n```\n\nTrailer.\n';
const fixture = (text = TEXT): { file: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-write-'));
  const file = join(dir, 'config.md');
  writeFileSync(file, text);
  return { file, dir };
};

test('the allowlist is exactly the four safe keys', () => {
  assert.deepEqual(Object.keys(ALLOWED).sort(), ['budget_weekend_weight', 'cost_profile', 'mode', 'watch_quiet_hours']);
});

test('changes only that key, keeps its comment and everything else, and writes a timestamped backup', () => {
  const { file, dir } = fixture();
  assert.equal(setSetting(file, 'mode', 'slim', NOW), 'changed');
  assert.equal(readFileSync(file, 'utf8'), TEXT.replace('mode: full ', 'mode: slim '));
  const backups = readdirSync(dir).filter((f) => f !== 'config.md');
  assert.deepEqual(backups, ['config.md.bak-20261105T130405Z']);
  assert.equal(readFileSync(join(dir, backups[0]!), 'utf8'), TEXT);
});

test('a key not in the block is appended inside it', () => {
  const { file } = fixture();
  assert.equal(setSetting(file, 'cost_profile', 'lean', NOW), 'changed');
  assert.match(readFileSync(file, 'utf8'), /watch_quiet_hours: 20:00-07:00\ncost_profile: lean\n```/);
});

test('unknown and non-allowlisted keys are refused, and nothing is written', () => {
  const { file, dir } = fixture();
  for (const key of ['notify_command', 'pr_max_code_lines', 'vault_root', 'nonsense', 'overlay', 'budget_monthly_usd']) {
    assert.throws(() => setSetting(file, key, 'x', NOW), /not an editable setting/, key);
  }
  assert.equal(readFileSync(file, 'utf8'), TEXT);
  assert.deepEqual(readdirSync(dir), ['config.md']);
});

test('invalid values are refused: enums, hours and the weekend weight', () => {
  const { file } = fixture();
  for (const [k, v] of [['mode', 'fast'], ['cost_profile', 'cheap'], ['watch_quiet_hours', '25:00-07:00'], ['watch_quiet_hours', 'x\nmode: slim'], ['budget_weekend_weight', '1.5'], ['budget_weekend_weight', 'abc'], ['mode', 'slim\n```']] as const) {
    assert.throws(() => setSetting(file, k, v, NOW), /must be/, `${k}=${v}`);
  }
  assert.equal(readFileSync(file, 'utf8'), TEXT);
});

test('setting the same value again is unchanged and writes no backup', () => {
  const { file, dir } = fixture();
  assert.equal(setSetting(file, 'mode', 'full', NOW), 'unchanged');
  assert.deepEqual(readdirSync(dir), ['config.md']);
});

test('accepts valid hours and weights', () => {
  const { file } = fixture();
  setSetting(file, 'watch_quiet_hours', '21:30-06:00', NOW);
  setSetting(file, 'budget_weekend_weight', '0.333', NOW);
  assert.match(readFileSync(file, 'utf8'), /watch_quiet_hours: 21:30-06:00\n/);
  assert.match(readFileSync(file, 'utf8'), /budget_weekend_weight: 0.333\n/);
});

test('a missing file or a disabled path is refused, not created', () => {
  const { dir } = fixture();
  assert.throws(() => setSetting(join(dir, 'nope.md'), 'mode', 'slim', NOW), /no config file/);
  assert.throws(() => setSetting('', 'mode', 'slim', NOW), /disabled/);
});
