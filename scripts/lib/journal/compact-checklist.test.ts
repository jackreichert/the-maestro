// Run: node --test scripts/lib/journal/compact-checklist.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactChecklist, CHECKLIST_SOURCES, MAX_CHECKLIST_LINES } from './compact-checklist.ts';

test('prints for startup and compact only', () => {
  assert.deepEqual([...CHECKLIST_SOURCES], ['startup', 'compact']);
  assert.ok(compactChecklist('compact').length > 0);
  assert.ok(compactChecklist('startup').length > 0);
  for (const s of ['resume', 'clear', '', undefined, 'COMPACT ', 'x']) assert.deepEqual(compactChecklist(s), []);
});

test('is short, names every duty and carries no org names', () => {
  const text = compactChecklist('compact').join('\n');
  assert.ok(compactChecklist('compact').length <= MAX_CHECKLIST_LINES);
  for (const needle of ['SKILL.md', 'CURRENT.md', 'priorities show', 'Agents:', 'footer', 'Haiku', 'worktree', 'event loop', 'Podium', 'journal.ts start']) assert.match(text, new RegExp(needle, 'i'), needle);
  assert.doesNotMatch(text, /arya/i);
});

function prime(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  return spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'journal.ts'), 'prime', '--no-update-check', '--project', 'p', '--vault', dir, '--allow-unmarked', ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_STATUS_DIR: join(dir, 's') } });
}

test('prime --source compact prints the checklist, other sources and none do not', () => {
  assert.match(prime(['--source', 'compact']).stdout, /After a compact/);
  assert.match(prime(['--source', 'startup']).stdout, /After a compact/);
  assert.doesNotMatch(prime(['--source', 'resume']).stdout, /After a compact/);
  assert.doesNotMatch(prime([]).stdout, /After a compact/);
});
