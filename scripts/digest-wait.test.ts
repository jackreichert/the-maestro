// Run: node --test scripts/digest-wait.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestBody, digestDir, claimDigests, saveDigest, unseenDigests } from './lib/digest-store.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'digest-wait-test-'));
const EVENT_LOOP = new URL('./event-loop.ts', import.meta.url).pathname;
const NOON = Date.parse('2026-10-01T12:00:00Z');
const envFor = (ledger: string, extra: Record<string, string> = {}) => ({ ...process.env, LEDGER_ROOT: ledger, MAESTRO_PROJECT: 'proj', MAESTRO_EVENT_DIR: join(ledger, 'Events'), ...extra });

test('digest store: saved unseen, listed oldest first, marked seen idempotently, never overwritten', () => {
  const dir = join(tempDir(), 'Digests');
  const a = saveDigest(dir, 'ACTION one', NOON);
  const b = saveDigest(dir, 'ACTION two', NOON);
  assert.notEqual(a, b);
  assert.deepEqual(unseenDigests(dir), [a, b]);
  assert.equal(b < a, false);
  assert.equal(readFileSync(a, 'utf8').split('\n')[0], '<!-- seen: false -->');
  assert.equal(digestBody(a), 'ACTION one');
  claimDigests(dir).find((c) => c.text === 'ACTION one')?.finish();
  assert.deepEqual(unseenDigests(dir), []);
  assert.equal(digestBody(a), 'ACTION one');
  assert.equal(readdirSync(dir).some((f) => f.endsWith('.tmp')), false);
});

/** Starts `event-loop.ts digest-wait` and resolves with its exit code and stdout. */
const waitProc = (ledger: string, args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const p = spawn(process.execPath, [EVENT_LOOP, 'digest-wait', '--poll-seconds', '0.1', ...args], { env: envFor(ledger) });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

test('digest-wait returns exit 10 on a digest saved later, prints it and marks it seen', async () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  const pending = waitProc(ledger, ['--timeout-hours', '0.01']);
  await new Promise((r) => setTimeout(r, 600));
  const file = saveDigest(dir, 'ACTION w1 (fake): changed');
  const r = await pending;
  assert.equal(r.code, 10);
  assert.equal(r.out.trim(), 'ACTION w1 (fake): changed');
  assert.deepEqual(unseenDigests(dir), []);
  assert.equal(readFileSync(file, 'utf8').split('\n')[0], '<!-- seen: true -->');
});

test('digest-wait takes an already-saved unseen digest at once; at the timeout it exits 0 and prints nothing', async () => {
  const ledger = tempDir();
  saveDigest(digestDir(ledger, 'proj'), 'ACTION early');
  assert.equal((await waitProc(ledger, [])).code, 10);
  const idle = await waitProc(ledger, ['--timeout-hours', '0.0003']);
  assert.deepEqual([idle.code, idle.out], [0, '']);
});


test('two waiters on one digest: exactly one prints it, the loser keeps waiting and exits 0', async () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  const both = Promise.all([waitProc(ledger, ['--timeout-hours', '0.0008']), waitProc(ledger, ['--timeout-hours', '0.0008'])]);
  await new Promise((r) => setTimeout(r, 600));
  saveDigest(dir, 'ACTION once');
  const r = await both;
  assert.deepEqual(r.map((x) => x.code).sort(), [0, 10]);
  assert.equal(r.map((x) => x.out).join('').trim(), 'ACTION once');
  assert.deepEqual(unseenDigests(dir), []);
});

test('a waiter killed between claim and finish: its claim is reclaimed and the digest shown again, once', async () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  saveDigest(dir, 'ACTION survive');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(claimDigests(dir, Date.now(), dead).length, 1);
  assert.deepEqual(unseenDigests(dir), []);
  const r = await waitProc(ledger, ['--timeout-hours', '0.01']);
  assert.deepEqual([r.code, r.out.trim()], [10, 'ACTION survive']);
  assert.equal(readdirSync(dir).filter((f) => f.includes('.claim-')).length, 0);
  assert.equal((await waitProc(ledger, ['--timeout-hours', '0.0003'])).code, 0);
});

test('a live claim is left alone until it is ten minutes old', () => {
  const dir = join(tempDir(), 'Digests');
  saveDigest(dir, 'ACTION held');
  const t = Date.now();
  assert.equal(claimDigests(dir, t).length, 1);
  assert.equal(claimDigests(dir, t + 60000).length, 0);
  assert.equal(claimDigests(dir, t + 11 * 60000).length, 1);
});
