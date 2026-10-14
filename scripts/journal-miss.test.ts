// Run: node --test scripts/journal-miss.test.ts
// Hermetic: a temp vault and a temp HOME; nothing is sent anywhere.
import { test } from 'node:test';
import { ASK_TEMPLATE } from './lib/ask-template-fixture.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function withLibrary() {
  const f = fixture();
  const lib = mkdtempSync(join(tmpdir(), 'journal-miss-lib-'));
  mkdirSync(join(lib, 'Projects', 'test-proj', 'Knowledge'), { recursive: true });
  writeFileSync(join(lib, 'Projects', 'test-proj', 'Knowledge', 'orchard-sync.md'), `---
type: library
kind: how-it-works
repo: test-proj
stream: Avonlea
components: [orchard-sync]
status: current
verified-at: 2026-10-01
verify-how: "read the page it names"
composed-by: composer
---

# Orchard sync

Read when: you change how orchards are synced.

## Facts

- The sync runs nightly (verified 2026-10-01, README.md:1)
`);
  const find = (...a: string[]) => f.run('find', ...a, '--tickets-vault', lib);
  return { ...f, find };
}

test('find with no match writes one miss row, exits 0, and a repeat the same day adds none', () => {
  const f = withLibrary();
  const first = f.find('zzzzqqqq harvest');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /no library pages match/);
  assert.match(first.stderr, /logged as a library miss/);
  const [row] = f.rows();
  assert.equal(row?.kind, 'miss');
  assert.equal(row?.source, 'find');
  assert.equal(row?.text, 'zzzzqqqq harvest');
  f.find('ZZZZQQQQ  harvest');
  assert.equal(f.rows().length, 1);
});

test('find with a hit, or with --no-miss, writes nothing', () => {
  const f = withLibrary();
  assert.match(f.find('orchard sync').stdout, /orchard-sync\.md/);
  assert.equal(f.find('zzzzqqqq', '--no-miss').status, 0);
  assert.throws(() => f.rows());
});

test('a secret-shaped query is not logged and the lookup still succeeds', () => {
  const f = withLibrary();
  const r = f.find(FAKE_KEY);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /not logged as a library miss/);
  assert.ok(!r.stderr.includes(FAKE_KEY));
  assert.throws(() => f.rows());
});

test('ask --how-do-i also logs a miss with source ask; a plain ask does not', () => {
  const f = fixture();
  const plain = f.run('ask', 'Ship it on Friday?', '--searched', 'test fixture', ...ASK_TEMPLATE, ...MARKS);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(f.rows().map((r) => r.kind), ['question']);
  const how = f.run('ask', 'How do I rebuild the orchard index?', '--how-do-i', '--repo', 'fake-repo', '--searched', 'test fixture', ...ASK_TEMPLATE, ...MARKS);
  assert.equal(how.status, 0, how.stderr);
  assert.match(how.stderr, /also logged as a library miss/);
  const rows = f.rows();
  assert.deepEqual(rows.map((r) => r.kind), ['question', 'question', 'miss']);
  assert.equal(rows[2]?.source, 'ask');
  assert.equal(rows[2]?.repo, 'fake-repo');
});

test('misses lists the open ones grouped by topic, as text and as json', () => {
  const f = fixture();
  f.run('miss', 'How do I rebuild the orchard index?', '--source', 'find', ...MARKS);
  f.run('miss', 'orchard index rebuild?', '--source', 'ask', ...MARKS);
  f.run('miss', 'harvest export schedule?', '--source', 'eval', ...MARKS);
  const text = f.run('misses');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^3 open misses in 2 topics/);
  const json = JSON.parse(f.run('misses', '--json').stdout) as { open: number; topics: { topic: string; misses: { source: string }[] }[] };
  assert.equal(json.open, 3);
  assert.deepEqual(json.topics.map((t) => [t.topic, t.misses.length]), [['index orchard rebuild', 2], ['export harvest schedule', 1]]);
});
