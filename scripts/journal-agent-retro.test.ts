// Run: node --test scripts/journal-agent-retro.test.ts
// Hermetic: a temp vault and a temp HOME; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARKS = ['--model', 'Test Model', '--used', 'skill:the-maestro'];
const FAKE_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

/** A temp ledger with one in-flight item; `briefed` adds the brief row `journal.ts brief` would write. */
function fixture({ briefed = true } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'journal-retro-'));
  const home = mkdtempSync(join(tmpdir(), 'journal-retro-home-'));
  const ledger = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a, '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true', VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_STATUS_DIR: join(vault, 'status'), MAESTRO_EVENT_DIR: join(vault, 'Events') },
  });
  const rows = () => readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const started = run('start', 'rebuild the orchard index', '--repo', 'fake-repo', '--stream', 'orchard', ...MARKS);
  assert.equal(started.status, 0, started.stderr);
  const id = String(rows()[0]?.id);
  if (briefed) appendFileSync(ledger, `${JSON.stringify({ id: 'bf01', ts: new Date().toISOString(), date: '2026-10-13', kind: 'brief', briefs: id, text: `brief ${id}` })}\n`);
  return { run, rows, id };
}

test('done refuses a briefed item with no retro; a retro lets it close', () => {
  const f = fixture();
  const refused = f.run('done', f.id, ...MARKS);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`agent-retro ${f.id}`));
  assert.equal(f.rows().filter((r) => r.kind === 'done').length, 0);
  const retro = f.run('agent-retro', f.id, '--lesson', 'code: the index rebuild needs the cache cleared first', '--lesson', 'jack: stage files by path', ...MARKS);
  assert.equal(retro.status, 0, retro.stderr);
  assert.match(retro.stdout, /retro: 2 lessons \(code 1, jack 1\)/);
  const row = f.rows().find((r) => r.kind === 'agent-retro');
  assert.equal(row?.retros, f.id);
  assert.equal(row?.stream, 'orchard');
  const closed = f.run('done', f.id, ...MARKS);
  assert.equal(closed.status, 0, closed.stderr);
});

test('done --no-retro closes with the reason recorded; an empty reason is refused', () => {
  const f = fixture();
  assert.notEqual(f.run('done', f.id, '--no-retro', ...MARKS).status, 0);
  const r = f.run('done', f.id, '--no-retro', 'the agent was stopped', ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.rows().find((x) => x.kind === 'done')?.noRetro, 'the agent was stopped');
  const listed = f.run('agent-retros', '--json');
  const out = JSON.parse(listed.stdout) as { missing: { item: string; noRetro?: string }[] };
  assert.deepEqual(out.missing.map((m) => [m.item, m.noRetro]), [[f.id, 'the agent was stopped']]);
});

test('an item never briefed closes without a retro, and drop is never gated', () => {
  const f = fixture({ briefed: false });
  assert.equal(f.run('done', f.id, ...MARKS).status, 0);
  const g = fixture();
  assert.equal(g.run('drop', g.id, '--why', 'not needed', ...MARKS).status, 0);
  assert.notEqual(g.run('drop', g.id, '--no-retro', 'x', ...MARKS).status, 0, '--no-retro is for done only');
});

test('agent-retro is idempotent, scans lessons and refuses an unknown item', () => {
  const f = fixture();
  const args = ['agent-retro', f.id, '--lesson', 'process: run the targeted test first', ...MARKS];
  assert.equal(f.run(...args).status, 0);
  assert.match(f.run(...args).stdout, /already recorded/);
  assert.equal(f.rows().filter((r) => r.kind === 'agent-retro').length, 1);
  const secret = f.run('agent-retro', f.id, '--lesson', `code: key ${FAKE_KEY}`, ...MARKS);
  assert.notEqual(secret.status, 0);
  assert.ok(!secret.stderr.includes(FAKE_KEY));
  assert.match(f.run('agent-retro', 'zz99', '--nothing', 'n/a', ...MARKS).stderr, /not an item/);
});

test('retro-reviewed closes a pending retro once, and verify accepts the rows', () => {
  const f = fixture();
  f.run('agent-retro', f.id, '--nothing', 'a one-line config change', ...MARKS);
  const retroId = String(f.rows().find((r) => r.kind === 'agent-retro')?.id);
  assert.match(f.run('agent-retros').stdout, /1 retro to review/);
  const r = f.run('retro-reviewed', retroId, '--note', 'nothing to promote', ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.run('agent-retros').stdout, /^0 retros to review/);
  assert.notEqual(f.run('retro-reviewed', retroId, '--note', 'again', ...MARKS).status, 0);
  const v = f.run('verify');
  assert.equal(v.status, 0, v.stdout + v.stderr);
});
