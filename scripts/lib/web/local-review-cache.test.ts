// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/local-review-cache.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordVerdict, localUnitId } from '../../review-verdict.ts';
import { createLocalReviewCache, spawnProducer, writeSnapshot } from './local-review-cache.ts';
import type { LocalReview, LocalUnit } from './local-review.ts';
import { createWebServer } from './server.ts';

const tmp = mkdtempSync(join(tmpdir(), 'lr-cache-'));
const ledger = join(tmp, 'ledger');
const statusDir = join(ledger, 'Status');
const container = join(tmp, 'container');
mkdirSync(statusDir, { recursive: true });
mkdirSync(join(ledger, 'Projects', 'p', 'Journal'), { recursive: true });
mkdirSync(container, { recursive: true });

const HEAD = 'a'.repeat(40);
const unit = (): LocalUnit => ({ id: localUnitId('alpha', 'feat/x'), repo: 'alpha', branch: 'feat/x', head: HEAD, ahead: 2, at: '2026-10-11T10:00:00Z', subject: 's', where: 'alpha', checkedOut: false, base: 'origin/staging', command: 'git difftool', verdict: { state: 'none' } });
const snapshot = (at: Date): LocalReview => ({ generatedAt: at.toISOString(), available: true, units: [unit()], more: 0, notes: ['n'], cleanup: { landed: 0, superseded: 0, special: 0, commands: [] } });
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

let scans = 0;
let finishScan: () => void = () => {};
/** A scan that is slow on purpose: it holds until the test lets it finish, then writes the snapshot. */
const slowScan = (file: string): Promise<void> => { scans += 1; return new Promise((ok) => { finishScan = () => { writeSnapshot(file, snapshot(new Date())); ok(); }; }); };

const clientDir = join(tmp, 'client');
mkdirSync(clientDir, { recursive: true });
writeFileSync(join(clientDir, 'index.html'), '<p>x</p>');
const page = { streams: [], repoStreams: {}, vaultName: 'V', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'x^', tz: 'UTC' };
const server = createWebServer({ web: { vault: ledger, project: 'p', statusDir, page, containerRoot: container }, clientDir, localReviewScan: slowScan, log: () => {} });
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

const hit = (path: string): Promise<{ status: number; ms: number; json: Record<string, unknown> }> => new Promise((ok, fail) => {
  const t0 = Date.now();
  const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, ms: Date.now() - t0, json: JSON.parse(text) as Record<string, unknown> })); });
  req.on('error', fail); req.end();
});

test('a slow scan never holds up a request: the queue answers "scanning" at once, /api/state stays fast, one scan runs', async () => {
  const first = await hit('/api/local-review');
  assert.equal(first.status, 200);
  assert.equal(first.json.available, false);
  assert.deepEqual(first.json.scan, { state: 'scanning' });
  assert.match(String(first.json.reason), /scan/);
  await sleep(300);   // the scan is still pending; ask again, and for the state, while it runs
  const [again, state] = await Promise.all([hit('/api/local-review'), hit('/api/state')]);
  assert.ok(first.ms < 500 && again.ms < 500 && state.ms < 500, `routes stayed fast (${first.ms}, ${again.ms}, ${state.ms} ms)`);
  assert.equal(state.status, 200);
  assert.equal(scans, 1, 'concurrency of one: the pending scan is not started twice');
  finishScan();
  await sleep(50);
  const done = await hit('/api/local-review');
  assert.equal(done.json.available, true);
  assert.deepEqual((done.json.scan as { state: string }).state, 'fresh');
  assert.equal((done.json.units as LocalUnit[]).length, 1);
  assert.ok((done.json.notes as string[]).some((n) => /Scanned/.test(n)));
  assert.equal(scans, 1, 'a fresh snapshot starts no scan');
});

test('verdicts recorded after the scan show without a rescan', async () => {
  recordVerdict(ledger, { pr: localUnitId('alpha', 'feat/x'), head: HEAD, verdict: 'SHIP IT', reviewer: 'r', fixer: 'f' });
  const r = await hit('/api/local-review');
  assert.equal((r.json.units as LocalUnit[])[0]?.verdict.state, 'ship-it');
  assert.equal(scans, 1);
});

test('an old snapshot is served with its age while one refresh runs; a failed refresh waits before retrying', async () => {
  const file = join(tmp, 'old.json');
  let t = new Date('2026-10-11T12:00:00Z');
  let calls = 0;
  let fail = true;
  writeSnapshot(file, snapshot(new Date('2026-10-11T11:50:00Z')));
  const cache = createLocalReviewCache({ file, now: () => t, staleMs: 120_000, retryMs: 60_000, scan: () => { calls += 1; return fail ? Promise.reject(new Error('boom')) : Promise.resolve(); } });
  const a = cache.read();
  assert.equal(a.scan.state, 'scanning');
  assert.equal(a.scan.ageSeconds, 600);
  assert.equal(a.units.length, 1);
  await sleep(20);
  const b = cache.read();
  assert.equal(b.scan.state, 'stale', 'the refresh failed: the list is labelled stale');
  assert.equal(calls, 1, 'no retry inside the wait');
  t = new Date(t.getTime() + 1000);
  cache.read();
  assert.equal(calls, 1, 'still inside retryMs');
});

test('the real producer scans a container into the snapshot file, in its own process', async () => {
  const sh = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
  const origin = join(tmp, 'origin.git');
  sh(tmp, 'init', '-q', '--bare', '-b', 'staging', origin);
  const repo = join(container, 'beta');
  sh(tmp, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, 'a.txt'), 'a'); sh(repo, 'add', 'a.txt'); sh(repo, 'commit', '-q', '-m', 'base'); sh(repo, 'push', '-q', 'origin', 'staging');
  sh(repo, 'switch', '-q', '-c', 'feat/y'); writeFileSync(join(repo, 'b.txt'), 'b'); sh(repo, 'add', 'b.txt'); sh(repo, 'commit', '-q', '-m', 'work');
  const file = join(tmp, 'out', 'snap.json');
  await spawnProducer(container)(file);
  assert.ok(existsSync(file));
  const j = JSON.parse(readFileSync(file, 'utf8')) as LocalReview;
  assert.deepEqual(j.units.map((u) => u.branch), ['feat/y']);
  assert.equal(j.units[0]?.ahead, 1);
  assert.equal(j.units[0]?.verdict.state, 'none');
});
