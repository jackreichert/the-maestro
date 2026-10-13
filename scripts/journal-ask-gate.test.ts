// Run: node --test scripts/journal-ask-gate.test.ts
// Hermetic: a temp vault and a temp HOME; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAskGate } from './lib/journal/ask-gate.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARKS = ['--model', 'Test Model', '--used', 'skill:the-maestro'];

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'ask-gate-'));
  const home = mkdtempSync(join(tmpdir(), 'ask-gate-home-'));
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a, '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true', VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_STATUS_DIR: join(vault, 'status'), MAESTRO_EVENT_DIR: join(vault, 'Events') },
  });
  const ledger = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { run, rows };
}

const flag = (value: string | null, given = value !== null) => ({ given, value });

test('the rule table refuses a missing, empty, control-laden or overlong --searched, and stores a clean one', () => {
  assert.match(parseAskGate({ searched: flag(null) }).errors[0] ?? '', /needs --searched/);
  assert.match(parseAskGate({ searched: flag('   ') }).errors[0] ?? '', /needs --searched/);
  assert.match(parseAskGate({ searched: flag('a\u0007b') }).errors[0] ?? '', /control character/);
  assert.match(parseAskGate({ searched: flag('x'.repeat(301)) }).errors[0] ?? '', /over 300/);
  assert.deepEqual(parseAskGate({ searched: flag('  the README\n and reference/ledger.md ') }), { gate: { searched: 'the README and reference/ledger.md' }, errors: [] });
});

test('ask without --searched exits 1 saying why and writes nothing', () => {
  const f = fixture();
  const r = f.run('ask', 'which way?', ...MARKS);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ask needs --searched "<where I looked>"/);
  assert.match(r.stderr, /caught before it reaches the user/);
  assert.deepEqual(f.rows(), []);
  const bare = f.run('ask', 'which way?', '--searched', ...MARKS);
  assert.equal(bare.status, 1, 'a flag with no value is a missing value');
  assert.deepEqual(f.rows(), []);
});

test('ask with --searched writes the row with the text, paste asks included', () => {
  const f = fixture();
  const r = f.run('ask', 'which way?', '--searched', 'README ask row, reference/ledger.md', ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.rows()[0]?.searched, 'README ask row, reference/ledger.md');
  const noSearch = f.run('ask', 'run this', '--paste', join(tmpdir(), 'nope'), ...MARKS);
  assert.equal(noSearch.status, 1);
  assert.match(noSearch.stderr, /needs --searched/);
});

test('--searched only goes on ask', () => {
  const f = fixture();
  const r = f.run('note', 'hello', '--searched', 'x', ...MARKS);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only goes on `ask`/);
  assert.deepEqual(f.rows(), []);
});
