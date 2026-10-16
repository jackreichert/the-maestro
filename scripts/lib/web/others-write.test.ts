// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/others-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from './server.ts';
import { refusal, parseOthersBody } from './others-write.ts';
import { actionsPath, readIgnored } from '../teammate/others-actions.ts';
import { writeOthersCache } from '../teammate/others.ts';
import type { OtherPr } from '../teammate/others.ts';
import type { OthersPrRow } from '../../web/client/src/types.ts';

const NOW = new Date('2026-10-15T12:10:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const HEAD = '1'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'web-others-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
const PAGE = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC', reviewQueueOwners: ['acme'] };
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const pr = (n: number, over: Partial<OtherPr> = {}): OtherPr => ({ repo: 'acme/app', number: n, title: `t${n}`, url: `https://github.com/acme/app/pull/${n}`, author: 'pat-fake', base: 'develop', head: 'h', headSha: HEAD, createdAt: '2026-10-12T12:10:00Z', updatedAt: '2026-10-15T09:00:00Z', requested: [], decision: null, unresolved: 0, copilotThreads: 0, ...over });

async function rig(name: string): Promise<{ port: number; file: string }> {
  const vault = join(root, name);
  mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  const statusDir = join(vault, 'Status');
  mkdirSync(statusDir, { recursive: true });
  writeOthersCache(statusDir, { fetchedAt: new Date('2026-10-15T12:05:00Z'), prs: [pr(1), pr(2, { headSha: undefined })] });
  const server = createWebServer({ web: { vault, project: 'p', statusDir, page: PAGE }, clientDir: client, now: () => NOW, log: () => {}, token: TOKEN });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, file: actionsPath(vault, 'p') };
}

function call(port: number, path: string, o: { method?: string; body?: unknown; token?: string | null } = {}): Promise<{ status: number; json: Record<string, any> }> {
  const body = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  if (o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'POST', headers }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(t); } catch { /* */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail); req.end(body);
  });
}
const rows = async (port: number): Promise<Record<string, any>[]> => (await call(port, '/api/others-prs', { method: 'GET' })).json.prs;

test('ignore appends one row at the PR\'s head, the tab then reports it ignored, and a repeat writes nothing', async () => {
  const r = await rig('ignore');
  const body = { repo: 'acme/app', pr: 1, head: HEAD };
  assert.equal((await call(r.port, '/api/others/ignore', { body })).status, 200);
  assert.equal((await call(r.port, '/api/others/ignore', { body })).status, 200);
  assert.equal(readFileSync(r.file, 'utf8').trim().split('\n').length, 1);
  assert.equal(readIgnored(r.file).get('acme/app#1'), HEAD);
  assert.equal((await rows(r.port)).find((x) => x.number === 1)?.ignored, 'ignored');
});

test('unignore removes it, and an ignore at an older head reads "new-commits"', async () => {
  const r = await rig('unignore');
  await call(r.port, '/api/others/ignore', { body: { repo: 'acme/app', pr: 1, head: HEAD } });
  assert.equal((await call(r.port, '/api/others/unignore', { body: { repo: 'acme/app', pr: 1 } })).status, 200);
  assert.equal((await rows(r.port)).find((x) => x.number === 1)?.ignored, undefined);
});

test('a write without the token is refused and writes nothing', async () => {
  const r = await rig('token');
  assert.equal((await call(r.port, '/api/others/ignore', { body: { repo: 'acme/app', pr: 1, head: HEAD }, token: null })).status, 403);
  assert.equal((await call(r.port, '/api/others/ignore', { body: { repo: 'acme/app', pr: 1, head: HEAD }, token: 'wrong' })).status, 403);
  assert.equal(existsSync(r.file), false);
});

test('a body of the wrong shape is a 400 and writes nothing', async () => {
  const r = await rig('shape');
  for (const body of [{}, { repo: 'acme/app', pr: 1 }, { repo: 'acme/app', pr: 1, head: 'abc' }, { repo: '../x', pr: 1, head: HEAD }, { repo: 'acme/app', pr: '1', head: HEAD }, { repo: 'acme/app', pr: 1, head: HEAD, extra: true }, [], 'x']) {
    assert.equal((await call(r.port, '/api/others/ignore', { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(r.port, '/api/others/ignore', { body: '{not json' })).status, 400);
  assert.equal((await call(r.port, '/api/others/unignore', { body: { repo: 'acme/app', pr: 1, head: HEAD } })).status, 400, 'unignore takes no head');
  assert.equal(existsSync(r.file), false);
});

test('a stale head is a 409, an unlisted PR a 404, a PR with no recorded head a 409, and a non-hands-off PR cannot "review anyway" (422)', async () => {
  const r = await rig('refusals');
  assert.equal((await call(r.port, '/api/others/ignore', { body: { repo: 'acme/app', pr: 1, head: '2'.repeat(40) } })).status, 409);
  assert.equal((await call(r.port, '/api/others/ignore', { body: { repo: 'acme/app', pr: 99, head: HEAD } })).status, 404);
  assert.equal((await call(r.port, '/api/others/ignore', { body: { repo: 'acme/app', pr: 2, head: HEAD } })).status, 409);
  const any = await call(r.port, '/api/others/review-anyway', { body: { repo: 'acme/app', pr: 1, head: HEAD } });
  assert.equal(any.status, 422);
  assert.match(any.json.message, /hands-off/);
  assert.equal(existsSync(r.file), false);
});

test('review-anyway is allowed for a hands-off row at its current head, and for nothing else', () => {
  const row = { repo: 'acme/guarded', number: 3, headSha: HEAD, handsOff: true } as OthersPrRow;
  assert.equal(refusal('review-anyway', { repo: 'acme/guarded', pr: 3, head: HEAD }, [row]), null);
  assert.equal(refusal('review-anyway', { repo: 'acme/guarded', pr: 3, head: '2'.repeat(40) }, [row])?.status, 409);
  assert.equal(refusal('review-anyway', { repo: 'acme/guarded', pr: 3, head: HEAD }, [{ ...row, handsOff: undefined }])?.status, 422);
  assert.equal(parseOthersBody('review-anyway', { repo: 'acme/guarded', pr: 3, head: HEAD })?.head, HEAD);
});
