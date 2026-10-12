// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/prs-refresh.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prsDirtyAt } from '../status-page/dirty.ts';
import { createWebServer } from './server.ts';
import { createRefresher } from './prs-refresh.ts';
import type { Rebuild } from './prs-refresh.ts';

const NOW = new Date('2026-10-06T15:00:00Z');
const TOKEN = 'test-token-0123456789';

/** A rebuild the test settles by hand, counting how often it was asked to run. */
function manual(): { rebuild: Rebuild; calls: () => number; ok: (stderr?: string) => void; fail: (e: unknown) => void } {
  let calls = 0;
  let settle: { ok: (v: { stderr: string }) => void; fail: (e: unknown) => void } | null = null;
  return {
    rebuild: () => { calls++; return new Promise((ok, fail) => { settle = { ok, fail }; }); },
    calls: () => calls,
    ok: (stderr = '') => settle?.ok({ stderr }),
    fail: (e) => settle?.fail(e),
  };
}
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'prs-refresh-')); mkdirSync(join(d, 'Status')); return join(d, 'Status'); };
const tick = (): Promise<void> => new Promise((ok) => setImmediate(ok));

test('a press touches the watcher\'s PR-dirty marker and runs one rebuild; success is reported as done', async () => {
  const statusDir = dir();
  const m = manual();
  const r = createRefresher({ statusDir, rebuild: m.rebuild, now: () => NOW });
  assert.equal(prsDirtyAt(statusDir), 0);
  assert.equal(r.start().state, 'running');
  assert.ok(prsDirtyAt(statusDir) > 0, 'the dirty marker was touched');
  m.ok();
  await tick();
  assert.deepEqual(r.status(), { state: 'done', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() });
});

test('a press while a rebuild runs starts nothing new, and a later press runs again', async () => {
  const m = manual();
  const r = createRefresher({ statusDir: dir(), rebuild: m.rebuild });
  r.start(); r.start(); r.start();
  assert.equal(m.calls(), 1);
  m.ok();
  await tick();
  r.start();
  assert.equal(m.calls(), 2);
});

test('a GitHub read that failed (exit 0, warning on stderr) is reported as failed with the reason', async () => {
  const m = manual();
  const r = createRefresher({ statusDir: dir(), rebuild: m.rebuild });
  r.start();
  m.ok('status-page: wrote x\nstatus-page: GitHub read failed (gh read failed after 3 tries: HTTP 502); the page carries a warning and uses the last cached PR data');
  await tick();
  assert.equal(r.status().state, 'failed');
  assert.match(r.status().message ?? '', /GitHub could not be read: gh read failed after 3 tries: HTTP 502\./);
});

test('the page lock refusing is shown as locked; any other failure is failed with fixed words and no path', async () => {
  const m = manual();
  const logged: string[] = [];
  const r = createRefresher({ statusDir: dir(), rebuild: m.rebuild, log: (l) => logged.push(l) });
  r.start();
  m.fail(Object.assign(new Error('Command failed: /secret/path/node'), { stderr: 'status-page: a status page refresh is already running (pid 1, 2 s ago); try again in a moment\n' }));
  await tick();
  assert.equal(r.status().state, 'locked');
  r.start();
  m.fail(Object.assign(new Error('Command failed: /secret/path/node'), { stderr: 'status-page: ledger read failed at /secret/path\n' }));
  await tick();
  assert.equal(r.status().state, 'failed');
  assert.doesNotMatch(r.status().message ?? '', /secret/);
  assert.equal(logged.length, 2);
});

interface Reply { status: number; body: string }
async function serve(m: ReturnType<typeof manual>, statusDir: string): Promise<{ port: () => number; close: () => void; post: (path: string, o?: { token?: string; body?: string; type?: string }) => Promise<Reply>; get: (path: string) => Promise<Reply> }> {
  const server = createWebServer({
    web: { vault: statusDir, project: 'p', statusDir, page: { streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'X-\\d+', tz: 'UTC' } },
    clientDir: statusDir, now: () => NOW, log: () => {}, token: TOKEN, prsRebuild: m.rebuild,
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (): number => (server.address() as AddressInfo).port;
  const send = async (method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> => {
    return new Promise((ok, fail) => {
      const req = request({ host: '127.0.0.1', port: port(), path, method, headers: { host: `127.0.0.1:${port()}`, ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', fail);
      req.end(body);
    });
  };
  return {
    port, close: () => server.close(),
    get: (path) => send('GET', path, {}),
    post: (path, o = {}) => {
      const body = o.body ?? '{}';
      return send('POST', path, { origin: `http://127.0.0.1:${port()}`, 'content-type': o.type ?? 'application/json', 'content-length': String(Buffer.byteLength(body)), ...(o.token === undefined ? { 'x-podium-token': TOKEN } : o.token ? { 'x-podium-token': o.token } : {}) }, body);
    },
  };
}

test('POST /api/prs/refresh needs the token and a body of exactly {}; GET on it is refused', async () => {
  const statusDir = dir();
  writeFileSync(join(statusDir, 'x'), '');
  const m = manual();
  const s = await serve(m, statusDir);
  after(() => s.close());
  assert.equal((await s.post('/api/prs/refresh', { token: '' })).status, 403);
  assert.equal((await s.post('/api/prs/refresh', { token: 'wrong-token-0123456789' })).status, 403);
  assert.equal((await s.post('/api/prs/refresh', { body: '{"path":"/etc"}' })).status, 400);
  assert.equal((await s.post('/api/prs/refresh', { body: '[]' })).status, 400);
  assert.equal((await s.post('/api/prs/refresh', { type: 'text/plain' })).status, 415);
  assert.equal((await s.get('/api/prs/refresh')).status, 405);
  assert.equal(m.calls(), 0, 'no refused request started a rebuild');
  assert.equal(prsDirtyAt(statusDir), 0);
});

test('POST /api/prs/refresh marks the PR data dirty and starts one rebuild; a second press is 409 and the state route follows it to done', async () => {
  const statusDir = dir();
  const m = manual();
  const s = await serve(m, statusDir);
  after(() => s.close());
  const first = await s.post('/api/prs/refresh');
  assert.equal(first.status, 202);
  assert.equal((JSON.parse(first.body) as { state: string }).state, 'running');
  assert.ok(prsDirtyAt(statusDir) > 0, 'the endpoint touched the dirty marker');
  const again = await s.post('/api/prs/refresh');
  assert.equal(again.status, 409);
  assert.equal(m.calls(), 1);
  assert.equal((JSON.parse((await s.get('/api/prs/refresh-state')).body) as { state: string }).state, 'running');
  m.ok();
  await tick();
  assert.equal((JSON.parse((await s.get('/api/prs/refresh-state')).body) as { state: string }).state, 'done');
});

test('a failed rebuild is visible on the state route', async () => {
  const m = manual();
  const s = await serve(m, dir());
  after(() => s.close());
  await s.post('/api/prs/refresh');
  m.fail(new Error('boom'));
  await tick();
  const state = JSON.parse((await s.get('/api/prs/refresh-state')).body) as { state: string; message: string };
  assert.equal(state.state, 'failed');
  assert.match(state.message, /refresh failed/);
});
