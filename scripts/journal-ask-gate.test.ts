// Run: node --test scripts/journal-ask-gate.test.ts
// Hermetic: a temp vault and a temp HOME; nothing is sent anywhere.
import { test } from 'node:test';
import { ASK_TEMPLATE } from './lib/ask-template-fixture.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAskGate, routeAsk } from './lib/journal/ask-gate.ts';

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
  assert.match(parseAskGate({ searched: flag(null), outward: false }).errors[0] ?? '', /needs --searched/);
  assert.match(parseAskGate({ searched: flag('   '), outward: false }).errors[0] ?? '', /needs --searched/);
  assert.match(parseAskGate({ searched: flag('a\u0007b'), outward: false }).errors[0] ?? '', /control character/);
  assert.match(parseAskGate({ searched: flag('x'.repeat(301)), outward: false }).errors[0] ?? '', /over 300/);
  assert.deepEqual(parseAskGate({ searched: flag('  the README\n and reference/ledger.md '), outward: false }), { gate: { searched: 'the README and reference/ledger.md' }, errors: [] });
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
  const r = f.run('ask', 'which way?', '--searched', 'README ask row, reference/ledger.md', ...ASK_TEMPLATE, ...MARKS);
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
  assert.match(r.stderr, /only go on `ask`/);
  assert.deepEqual(f.rows(), []);
});

const SEARCHED = ['--searched', 'test fixture', ...ASK_TEMPLATE];
const TWO_WAY = ['--door', 'two-way', '--default', 'use the nightly window', '--recommend', 'nightly'];

test('the rule table parses --outward and routeAsk acts only on a two-way default that is not outward', () => {
  assert.deepEqual(parseAskGate({ searched: flag('docs'), outward: true }).gate, { searched: 'docs', outward: true });
  const fields = { door: 'two-way', default: 'use the nightly window' } as const;
  assert.equal(routeAsk('which window?', fields, { searched: 'docs' }).acted, 'use the nightly window');
  assert.equal(routeAsk('which window?', fields, { searched: 'docs', outward: true }).acted, null);
  assert.equal(routeAsk('which window?', { door: 'one-way' }, {}).acted, null);
  assert.equal(routeAsk('which window?', { door: 'two-way' }, {}).acted, null, 'no default, nothing to act on');
  assert.equal(routeAsk('which window?', { default: 'x' }, {}).acted, null, 'no door is one-way');
});

test('a two-way ask with a default is acted on: logged as a note, not on the board', () => {
  const f = fixture();
  const r = f.run('ask', 'which window?', ...TWO_WAY, ...SEARCHED, ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^acted /);
  const [row] = f.rows();
  assert.equal(row?.kind, 'note');
  assert.equal(row?.text, 'acted on default: use the nightly window (asked: which window?)');
  assert.equal(row?.searched, 'test fixture');
  assert.equal(row?.pending, undefined);
  const status = f.run('status', '--json');
  assert.doesNotMatch(status.stdout, /which window/, 'it is not on the awaiting-you board');
});

test('an --outward ask always asks, and one that carries a default is refused with nothing written', () => {
  const f = fixture();
  const r = f.run('ask', 'post the update in Slack?', '--door', 'two-way', '--recommend', 'post', '--outward', ...SEARCHED, ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^question /);
  const [row] = f.rows();
  assert.equal(row?.kind, 'question');
  assert.equal(row?.outward, true);
  assert.match(f.run('status', '--json').stdout, /post the update in Slack/);
  const bad = f.run('ask', 'post it?', ...TWO_WAY, '--outward', ...SEARCHED, ...MARKS);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--outward ask can never carry a default/);
  assert.equal(f.rows().length, 1);
});

test('a question cannot be written around the gate with log or note --kind question', () => {
  const f = fixture();
  const r = f.run('log', 'which way?', '--kind', 'question', ...MARKS);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /goes through `ask`/);
  assert.deepEqual(f.rows(), []);
});

test('one-way and two-way asks with no default still ask; --outward only goes on ask', () => {
  const f = fixture();
  assert.match(f.run('ask', 'one way?', ...SEARCHED, ...MARKS).stdout, /^question /);
  assert.match(f.run('ask', 'two way, no default?', '--door', 'two-way', ...SEARCHED, ...MARKS).stdout, /^question /);
  const stray = f.run('note', 'hello', '--outward', ...MARKS);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /only go on `ask`/);
});
