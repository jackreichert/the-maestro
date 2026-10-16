// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/scripts-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from './server.ts';
import type { WebConfig } from './api.ts';
import { openStore } from '../journal/store.ts';
import { registerScript } from '../scripts/register.ts';
import type { NewScript } from '../scripts/registry.ts';
import { scriptsPath } from '../scripts/registry.ts';

const NOW = new Date('2026-10-15T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const root = mkdtempSync(join(tmpdir(), 'web-scripts-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
const PAGE = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };
const SCRIPT: NewScript = { kind: 'one-time', title: 'Say hello', what: 'Prints a greeting.', why: 'Proves the reviewed-run path.', after: 'Nothing changes.', blocks: 'abcd', command: 'echo hello-from-script' };

interface Rig { server: Server; port: number; vault: string; register: (s?: Partial<NewScript>) => { id: string; ask: string }; ledger: () => Record<string, any>[] }
const rigs: Rig[] = [];
async function rig(name: string): Promise<Rig> {
  const vault = join(root, name);
  const statusDir = join(vault, 'Status');
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  const store = openStore({ vault, project: 'p', dryRun: false, warn: () => {} });
  const register = (s: Partial<NewScript> = {}): { id: string; ask: string } => {
    const out = registerScript({ store, vault, project: 'p', script: { ...SCRIPT, ...s }, now: NOW, today: '2026-10-15', askExtras: { stream: 'Alpha' } });
    assert.ok(out.ok, out.ok ? '' : out.errors.join());
    return out.ok ? { id: out.entry.id, ask: out.entry.ask } : { id: '', ask: '' };
  };
  const web: WebConfig = { vault, project: 'p', statusDir, page: PAGE };
  const server = createWebServer({ web, clientDir: client, now: () => NOW, log: () => {}, token: TOKEN, home: root, runShell: '/bin/sh' });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const r: Rig = { server, port: (server.address() as AddressInfo).port, vault, register, ledger: () => store.readLedger() as Record<string, any>[] };
  rigs.push(r);
  return r;
}
after(() => { for (const r of rigs) r.server.close(); });

interface Reply { status: number; json: Record<string, any> }
function send(r: Rig, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}): Promise<Reply> {
  const body = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...o.headers };
  if (o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
  if (o.method === 'GET') { delete headers['content-type']; delete headers['content-length']; }
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: r.port, path, method: o.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail);
    req.end(body);
  });
}
const get = (r: Rig, path: string): Promise<Reply> => send(r, path, { method: 'GET', token: null });
const ran = (r: Rig, id: string, o: Parameters<typeof send>[2] = {}): Promise<Reply> => send(r, '/api/scripts/ran', { body: { id }, ...o });
const sleep = (ms: number): Promise<void> => new Promise((x) => setTimeout(x, ms));

test('GET /api/scripts lists the entries with their state, shows the command verbatim and writes nothing', async () => {
  const r = await rig('list');
  const { id, ask } = r.register();
  const before = readFileSync(scriptsPath(r.vault, 'p'), 'utf8');
  const out = await get(r, '/api/scripts');
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.scripts.map((s: any) => [s.id, s.status, s.askOpen, s.ask, s.command]), [[id, 'blocked', true, ask, 'echo hello-from-script']]);
  assert.equal(readFileSync(scriptsPath(r.vault, 'p'), 'utf8'), before);
});

test('the ask card carries the script id, so the page can link it to the Scripts tab', async () => {
  const r = await rig('card');
  const { id, ask } = r.register();
  const state = await get(r, '/api/state');
  assert.equal(state.status, 200);
  const card = (state.json.asks as any[]).find((a) => a.id === ask);
  assert.equal(card.script, id);
  assert.match(card.needed, /Run this script: Say hello/);
  assert.match(card.context, /What it does/);
  assert.ok(card.paste);
});

test('Mark done resolves a one-time script\'s ask and moves it to History; a second mark is refused', async () => {
  const r = await rig('mark-one-time');
  const { id, ask } = r.register();
  const a = await ran(r, id);
  assert.deepEqual([a.status, a.json.ok, a.json.resolvedAsk], [200, true, true]);
  const closing = r.ledger().find((x) => x.closes === ask);
  assert.match(closing?.text, /Marked done: ran it myself \(Say hello\)/);
  const list = await get(r, '/api/scripts');
  assert.deepEqual([list.json.scripts[0].status, list.json.scripts[0].lastRun.via, list.json.scripts[0].lastRun.result], ['history', 'marked', 'done']);
  const b = await ran(r, id);
  assert.deepEqual([b.status, b.json.error], [409, 'finished']);
});

test('Mark run on a reusable script resolves the ask the first time and only records a run after that', async () => {
  const r = await rig('mark-reusable');
  const { id, ask } = r.register({ kind: 'reusable' });
  assert.equal((await ran(r, id)).json.resolvedAsk, true);
  const second = await ran(r, id);
  assert.deepEqual([second.status, second.json.resolvedAsk], [200, false]);
  assert.equal(r.ledger().filter((x) => x.closes === ask).length, 1);
  const s = (await get(r, '/api/scripts')).json.scripts[0];
  assert.deepEqual([s.status, s.runs], ['reusable', 2]);
});

test('the ran route holds the same guards as every write: token, origin, shape, id', async () => {
  const r = await rig('guards');
  const { id } = r.register();
  assert.equal((await ran(r, id, { token: null })).status, 403);
  assert.equal((await ran(r, id, { token: 'wrong' })).status, 403);
  assert.equal((await ran(r, id, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await ran(r, id, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await get(r, '/api/scripts/ran')).status, 405);
  assert.equal((await send(r, '/api/scripts/ran', { body: { id, result: 'failed' } })).status, 400, 'no extra keys');
  assert.equal((await send(r, '/api/scripts/ran', { body: { id: 'sc-../../x' } })).status, 400);
  assert.equal((await send(r, '/api/scripts/ran', { body: [id] })).status, 400);
  assert.equal((await ran(r, 'sc-00000000')).status, 404);
  assert.equal((await get(r, '/api/scripts')).json.scripts[0].status, 'blocked', 'nothing above recorded a run');
});

test('the Run button path: the ask previews the stored command verbatim, runs it through the reviewed route, and resolving it finishes the script', async () => {
  const r = await rig('reviewed-run');
  const { id, ask } = r.register();
  const p = await send(r, '/api/run/preview', { body: { source: 'ask', id: ask } });
  assert.equal(p.json.command, 'echo hello-from-script\n');
  assert.equal(p.json.runnable, true);
  const start = await send(r, '/api/run/start', { body: { source: 'ask', id: ask, sha256: p.json.sha256 } });
  assert.equal(start.status, 200);
  let end: Record<string, any> = {};
  for (let i = 0; i < 200 && end.status !== 'done'; i++) { end = (await send(r, '/api/run/poll', { body: { runId: start.json.runId, since: 0 } })).json; await sleep(25); }
  assert.equal(end.status, 'done');
  assert.match((end.chunks as { text: string }[]).map((c) => c.text).join(''), /hello-from-script/);
  assert.equal((await send(r, '/api/run/resolve', { body: { runId: start.json.runId } })).status, 200);
  const s = (await get(r, '/api/scripts')).json.scripts.find((x: any) => x.id === id);
  assert.deepEqual([s.status, s.lastRun.via, s.lastRun.result], ['history', 'podium', 'done']);
});

test('the tab shows the block file, the one copy the Run button executes, so an edited entry row cannot make the review differ from the run', async () => {
  const r = await rig('tamper');
  const { ask } = r.register();
  const file = scriptsPath(r.vault, 'p');
  writeFileSync(file, readFileSync(file, 'utf8').replace('echo hello-from-script', 'echo tampered'));
  const p = await send(r, '/api/run/preview', { body: { source: 'ask', id: ask } });
  assert.equal(p.json.command, 'echo hello-from-script\n');
  assert.equal((await get(r, '/api/scripts')).json.scripts[0].command, 'echo hello-from-script');
});
