// Run: node --test scripts/digest-wait.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestBody, digestDir, claimDigests, drainDigests, saveDigest, unseenDigests } from './lib/digest-store.ts';
import { cleanEnv } from './lib/test-env.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'digest-wait-test-'));
const EVENT_LOOP = new URL('./event-loop.ts', import.meta.url).pathname;
const NOON = Date.parse('2026-10-01T12:00:00Z');
const envFor = (ledger: string, extra: Record<string, string> = {}) => ({ ...cleanEnv(), LEDGER_ROOT: ledger, MAESTRO_PROJECT: 'proj', MAESTRO_EVENT_DIR: join(ledger, 'Events'), ...extra });

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
const waitProc = (ledger: string, args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const p = spawn(process.execPath, [EVENT_LOOP, 'digest-wait', '--poll-seconds', '0.1', ...args], { env: envFor(ledger, env) });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

test('digest-wait (an alias of events wait) returns exit 10 on a digest saved later, prints its event and marks the digest seen', async () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  const pending = waitProc(ledger, ['--timeout-hours', '0.01']);
  await new Promise((r) => setTimeout(r, 600));
  const file = saveDigest(dir, 'ACTION w1 (fake): changed');
  const r = await pending;
  assert.equal(r.code, 10);
  assert.match(r.out.trim(), /^[0-9a-f]{12} new ACTION other w1 \(fake\)$/);
  assert.deepEqual(unseenDigests(dir), []);
  assert.equal(readFileSync(file, 'utf8').split('\n')[0], '<!-- seen: true -->');
});

test('digest-wait takes an already-saved unseen digest at once; at the timeout it exits 0 and prints nothing', async () => {
  const ledger = tempDir();
  saveDigest(digestDir(ledger, 'proj'), 'ACTION early (fake): changed');
  assert.equal((await waitProc(ledger, [])).code, 10);
  const idle = await waitProc(ledger, ['--timeout-hours', '0.0003']);
  assert.deepEqual([idle.code, idle.out], [0, '']);
});


test('two waiters on one digest: exactly one prints it, the loser keeps waiting and exits 0', async () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  // Two windows: without MAESTRO_WINDOW both waiters would resolve to this test process as their parent and be one window, which
  // may each take an unowned event when their reads overlap. The digest is saved first, so the waiters race for it from their first poll.
  saveDigest(dir, 'ACTION once (fake): changed');
  const both = Promise.all(['win-a', 'win-b'].map((w) => waitProc(ledger, ['--timeout-hours', '0.0008'], { MAESTRO_WINDOW: w })));
  const r = await both;
  assert.deepEqual(r.map((x) => x.code).sort(), [0, 10]);
  assert.match(r.map((x) => x.out).join('').trim(), /^[0-9a-f]{12} new ACTION other once \(fake\)$/);
  assert.deepEqual(unseenDigests(dir), []);
});

test('a waiter killed between claim and finish: its claim is reclaimed and the digest shown again, once', async () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  saveDigest(dir, 'ACTION survive (fake): changed');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(claimDigests(dir, Date.now(), dead).length, 1);
  assert.deepEqual(unseenDigests(dir), []);
  const r = await waitProc(ledger, ['--timeout-hours', '0.01']);
  assert.equal(r.code, 10);
  assert.match(r.out.trim(), /^[0-9a-f]{12} new ACTION other survive \(fake\)$/);
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

test('drainDigests shows fresh digests and counts older unread ones in a line instead of dropping them silently', () => {
  const dir = join(tempDir(), 'Digests');
  saveDigest(dir, 'ACTION saturday', NOON - 50 * 3600_000);
  saveDigest(dir, 'ACTION sunday', NOON - 26 * 3600_000);
  saveDigest(dir, 'note fresh', NOON - 3600_000);
  const out = drainDigests(dir, NOON);
  assert.equal(out.length, 2);
  assert.equal(out[0], 'note fresh');
  assert.match(out[1], /^2 older digests were unread for over 24h and are marked seen \(oldest 2d\), in /);
  assert.ok(out[1].endsWith(dir));
  assert.deepEqual(unseenDigests(dir), []);
  assert.deepEqual(drainDigests(dir, NOON), [], 'a second drain has nothing left to say');
});

