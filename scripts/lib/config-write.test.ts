// Run: node --test scripts/lib/config-write.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfigValue, setAutoPull } from './config-write.ts';
import { parseConfig } from '../local-config.ts';

const block = (body: string): string => `# prose\n\n\`\`\`maestro-config\n${body}\n\`\`\`\n\nmore prose\n`;

test('a block without the key gets it appended; other lines, comments and prose are untouched', () => {
  const out = setConfigValue(block('gh_org: acme\n# a comment\nupdate_check: on   # keep'), 'auto_pull', 'on');
  assert.equal(out, block('gh_org: acme\n# a comment\nupdate_check: on   # keep\nauto_pull: on'));
});

test('an existing line is replaced in place, keeping its trailing comment and neighbours', () => {
  const out = setConfigValue(block('gh_org: acme\nauto_pull: off   # asked 2026-10-05\nproject: x'), 'auto_pull', 'on');
  assert.equal(out, block('gh_org: acme\nauto_pull: on   # asked 2026-10-05\nproject: x'));
});

test('a commented-out line is not the setting; the key is appended instead', () => {
  const out = setConfigValue(block('# auto_pull: off'), 'auto_pull', 'on');
  assert.equal(parseConfig(out).auto_pull, 'on');
  assert.match(out, /# auto_pull: off\nauto_pull: on\n```/);
});

test('text with no block gets one appended; an empty string becomes just the block', () => {
  assert.equal(setConfigValue('# my notes\n', 'auto_pull', 'off'), '# my notes\n\n```maestro-config\nauto_pull: off\n```\n');
  assert.equal(setConfigValue('# no newline', 'auto_pull', 'off'), '# no newline\n\n```maestro-config\nauto_pull: off\n```\n');
  assert.equal(setConfigValue('', 'auto_pull', 'off'), '```maestro-config\nauto_pull: off\n```\n');
});

test('an empty block takes the line', () => {
  assert.equal(parseConfig(setConfigValue('```maestro-config\n```\n', 'auto_pull', 'on')).auto_pull, 'on');
});

test('setAutoPull creates the file and directory, then is idempotent and flips on request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgw-'));
  const path = join(dir, 'nested', 'config.md');
  assert.equal(setAutoPull(path, 'on'), 'created');
  assert.equal(parseConfig(readFileSync(path, 'utf8')).auto_pull, 'on');
  const first = readFileSync(path, 'utf8');
  assert.equal(setAutoPull(path, 'ON'), 'unchanged');
  assert.equal(readFileSync(path, 'utf8'), first);
  assert.equal(setAutoPull(path, 'off'), 'changed');
  assert.equal(parseConfig(readFileSync(path, 'utf8')).auto_pull, 'off');
  assert.equal(readFileSync(path, 'utf8').match(/auto_pull/g)?.length, 1);
});

test('setAutoPull keeps an existing file whole and adds the block to a file that has none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgw-'));
  const path = join(dir, 'config.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, '# mine\nsome notes\n');
  assert.equal(setAutoPull(path, 'off'), 'changed');
  assert.equal(readFileSync(path, 'utf8'), '# mine\nsome notes\n\n```maestro-config\nauto_pull: off\n```\n');
});

test('setAutoPull rejects any value but on/off and a disabled config path, writing nothing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cfgw-')), 'config.md');
  for (const bad of ['', 'maybe', 'true', '1']) assert.throws(() => setAutoPull(path, bad), /must be "on" or "off"/);
  assert.throws(() => setAutoPull('', 'on'), /disabled/);
  assert.equal(existsSync(path), false);
});

test('journal.ts autopull writes MAESTRO_LOCAL_CONFIG without needing a ledger, and rejects a bad value', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cfgw-')), 'config.md');
  const script = new URL('../journal.ts', import.meta.url).pathname;
  const run = (...a: string[]) => spawnSync(process.execPath, [script, 'autopull', ...a], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', MAESTRO_LOCAL_CONFIG: path } });
  const ok = run('on');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /autopull  on  created/);
  assert.equal(parseConfig(readFileSync(path, 'utf8')).auto_pull, 'on');
  assert.match(run('on').stdout, /unchanged/);
  const bad = run('sometimes');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: journal.ts autopull on\|off/);
  assert.equal(run().status, 1);
});
