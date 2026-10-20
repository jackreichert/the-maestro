// Run: node --test scripts/slack-triage.test.ts
// Runs the CLI on temp files only: a stub rules table and new-messages file with fictional names. No Slack, no vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./slack-triage.ts', import.meta.url));
const SENTINEL = 'SENTINEL-message-text';

function fixture(): { dir: string; rules: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'slack-triage-'));
  const rules = join(dir, 'rules.json');
  writeFileSync(rules, JSON.stringify({
    me: ['Arthur'],
    channels: { eng: { group: 'engineering', playbook: 'engineering.md' } },
    rules: [{ name: 'reminder-bot', reason: 'standup reminder', verdict: 'drop', authors: ['Marvin'] }],
  }));
  const file = join(dir, 'eng.new-20261015T120000Z.md');
  writeFileSync(file, [
    '# Slack new messages: eng', '', 'New lines: 3', '',
    `- 2026-10-15 08:00 ET **Marvin**: ${SENTINEL} reminder`,
    `- 2026-10-15 08:05 ET **Ford**: @Arthur ${SENTINEL} can you look`,
    `- 2026-10-15 08:06 ET ↳ **Trillian**: ${SENTINEL} on it`,
  ].join('\n'));
  return { dir, rules, file };
}

const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_OVERLAY: '', ...env } });

test('prints one JSON decision per message, without the message text', () => {
  const { dir, rules, file } = fixture();
  const r = run(['--rules', rules, file]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(SENTINEL));
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(rows.map((d) => [d.line, d.verdict, d.rule]), [[5, 'drop', 'reminder-bot'], [6, 'surface', 'no-rule+mention'], [7, 'model', 'no-rule']]);
  assert.equal(rows[1]!.label, 'ask');
  assert.equal(rows[0]!.playbook, join(dir, 'engineering.md'));
  assert.equal(rows[0]!.file, file);
});

test('--counts prints the verdict totals, and --tag overrides the header', () => {
  const { rules, file } = fixture();
  const r = run(['--rules', rules, '--counts', file]);
  assert.equal(r.stdout.trim(), 'messages=3 drop=1 model=1 surface=1 escalate=0');
  const stray = run(['--rules', rules, '--tag', 'stray', '--counts', file]);
  assert.equal(stray.stdout.trim(), 'messages=3 drop=1 model=0 surface=1 escalate=1', 'a tag with no playbook escalates');
});

test('the rules file defaults to slack_triage_rules from the config', () => {
  const { rules, file } = fixture();
  const r = run(['--counts', file], { MAESTRO_SLACK_TRIAGE_RULES: rules });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^messages=3 /);
});

test('bad arguments and a bad rules file exit 2 with a reason', () => {
  const { dir, file } = fixture();
  assert.match(run([file]).stderr, /no rules file/);
  assert.equal(run([file]).status, 2);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ me: ['Arthur'], channels: {}, rules: [{ name: 'x', reason: 'r', verdict: 'drop', match: '(' }] }));
  const r = run(['--rules', bad, file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rule 1 \(x\) has a match that is not a valid regular expression/);
  assert.match(run(['--rules', join(dir, 'missing.json'), file]).stderr, /ENOENT|no such file/i);
  assert.match(run(['--rules']).stderr, /--rules needs a value/);
});
