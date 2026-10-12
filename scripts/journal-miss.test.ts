// Run: node --test scripts/journal-miss.test.ts
// Hermetic: a temp vault and a temp HOME; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARKS = ['--model', 'Test Model', '--used', 'skill:the-maestro'];
const FAKE_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'journal-miss-'));
  const home = mkdtempSync(join(tmpdir(), 'journal-miss-home-'));
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a, '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true', VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_STATUS_DIR: join(vault, 'status'), MAESTRO_EVENT_DIR: join(vault, 'Events') },
  });
  const rows = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  return { run, rows };
}

test('miss writes one row with its source and topic', () => {
  const f = fixture();
  const r = f.run('miss', 'How do I rebuild the orchard index?', '--source', 'ask', '--repo', 'fake-repo', ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  const [row] = f.rows();
  assert.equal(row?.kind, 'miss');
  assert.equal(row?.source, 'ask');
  assert.equal(row?.topic, 'index orchard rebuild');
  assert.equal(row?.repo, 'fake-repo');
});

test('the same question twice in a day writes one row', () => {
  const f = fixture();
  f.run('miss', 'orchard index?', '--source', 'find', ...MARKS);
  const again = f.run('miss', 'Orchard  index?', '--source', 'find', ...MARKS);
  assert.match(again.stdout, /already recorded today/);
  assert.equal(f.rows().length, 1);
});

test('a secret-shaped question is refused and nothing is written', () => {
  const f = fixture();
  const r = f.run('miss', `why does ${FAKE_KEY} fail`, '--source', 'find', ...MARKS);
  assert.notEqual(r.status, 0);
  assert.ok(!r.stderr.includes(FAKE_KEY));
  assert.throws(() => f.rows());
});

test('log --kind miss is refused, and verify passes a ledger with a miss', () => {
  const f = fixture();
  assert.notEqual(f.run('log', 'sneaky', '--kind', 'miss', ...MARKS).status, 0);
  f.run('miss', 'orchard index?', '--source', 'eval', ...MARKS);
  const v = f.run('verify');
  assert.equal(v.status, 0, v.stdout + v.stderr);
});
