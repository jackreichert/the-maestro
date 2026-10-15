// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/run-script.test.ts
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
import { RUN_CATALOG_PATH, RUN_POLL_PATH, RUN_PREVIEW_PATH, RUN_START_PATH } from './run-write.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const root = mkdtempSync(join(tmpdir(), 'web-script-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
const PAGE_CONFIG = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };

const CATALOG = {
  scripts: [
    { id: 'say', name: 'Say', description: 'Echo words.', group: 'test', command: ['/bin/echo', 'said'], args: [{ name: 'word', type: 'string', pattern: '^[a-z$()`;&|*-]{1,20}$', description: 'a word' }, { name: 'times', type: 'integer', flag: '--times', min: 1, max: 5 }, { name: 'loud', type: 'boolean', flag: '--loud' }], readOnly: true, tier: 'haiku', timeoutSeconds: 10 },
    { id: 'strict', name: 'Strict', description: 'Only simple words.', group: 'test', command: ['/bin/echo', 'strict'], args: [{ name: 'word', type: 'string', flag: '--word', pattern: '^[a-z]{1,10}$' }], readOnly: true, tier: 'none', timeoutSeconds: 10 },
    { id: 'writer', name: 'Writer', description: 'Can write.', group: 'test', command: ['/bin/echo', 'wrote'], args: [], readOnly: false, tier: 'sonnet', timeoutSeconds: 10 },
    { id: 'slow', name: 'Slow', description: 'Sleeps.', group: 'test', command: ['/bin/sleep', '20'], args: [], readOnly: true, tier: 'none', timeoutSeconds: 30 },
    { id: 'broken', name: 'Broken', description: 'Bad entry.', group: 'test', command: ['sh', '-c', 'x'], args: [], readOnly: true, tier: 'none', timeoutSeconds: 10 },
  ],
};

interface Rig { server: Server; port: number; ledger: string }
const rigs: Rig[] = [];
async function rig(name: string): Promise<Rig> {
  const vault = join(root, name);
  const ledger = join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl');
  mkdirSync(join(vault, 'Status'), { recursive: true }); mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  writeFileSync(ledger, '');
  const catalogFile = join(vault, 'scripts.json');
  writeFileSync(catalogFile, JSON.stringify(CATALOG));
  const web: WebConfig = { vault, project: 'p', statusDir: join(vault, 'Status'), page: PAGE_CONFIG };
  const server = createWebServer({ web, clientDir: client, now: () => NOW, log: () => {}, token: TOKEN, home: root, catalogFile });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const r = { server, port: (server.address() as AddressInfo).port, ledger };
  rigs.push(r);
  return r;
}
after(() => { for (const r of rigs) r.server.close(); });

interface Reply { status: number; json: Record<string, any> }
function post(r: Rig, path: string, body: unknown, token: string | null = TOKEN): Promise<Reply> {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
  if (token !== null) headers['x-podium-token'] = token;
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: r.port, path, method: 'POST', headers }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(t); } catch { /* not JSON */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail);
    req.end(text);
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const src = (name: string, args?: unknown) => ({ source: 'script', name, ...(args === undefined ? {} : { args }) });
async function runToEnd(r: Rig, name: string, args?: unknown, extra: object = {}): Promise<{ start: Reply; end: Record<string, any> }> {
  const p = await post(r, RUN_PREVIEW_PATH, src(name, args));
  const start = await post(r, RUN_START_PATH, { ...src(name, args), sha256: p.json.sha256, ...extra });
  if (start.status !== 200) return { start, end: {} };
  for (let i = 0; i < 200; i++) {
    const poll = await post(r, RUN_POLL_PATH, { runId: start.json.runId, since: 0 });
    if (poll.json.status !== 'running') return { start, end: poll.json };
    await sleep(25);
  }
  throw new Error('run did not finish');
}
const outText = (end: Record<string, any>): string => (end.chunks as { text: string }[]).map((c) => c.text).join('');

test('the catalog lists valid entries without their commands, and says what failed to load', async () => {
  const r = await rig('list');
  assert.equal((await post(r, RUN_CATALOG_PATH, {}, null)).status, 403);
  const c = await post(r, RUN_CATALOG_PATH, {});
  assert.deepEqual(c.json.scripts.map((s: any) => s.id), ['say', 'strict', 'writer', 'slow']);
  assert.ok(c.json.scripts.every((s: any) => s.command === undefined));
  assert.equal(c.json.scripts[0].readOnly, true);
  assert.equal(c.json.scripts[0].tier, 'haiku');
  assert.match(c.json.problems[0], /broken/);
  assert.equal((await post(r, RUN_PREVIEW_PATH, src('broken'))).status, 404, 'an invalid entry cannot be previewed or run');
});

test('a script runs as argv: shell metacharacters in an arg are passed literally', async () => {
  const r = await rig('argv');
  const { end } = await runToEnd(r, 'say', { word: '$(id);`id`&|*', times: 2, loud: true });
  assert.equal(outText(end), 'said $(id);`id`&|* --times 2 --loud\n');
  assert.equal(end.exitCode, 0);
  const row = readFileSync(r.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.kind === 'run');
  assert.equal(row.runSource, 'script');
  assert.equal(row.runTarget, 'say');
  assert.ok(!JSON.stringify(row).includes('said'), 'no output in the ledger');
});

test('args off their schema are refused before anything runs', async () => {
  const r = await rig('bad-args');
  for (const [name, args] of [['strict', { word: '$(id)' }], ['strict', { word: 'a b' }], ['strict', { word: 'x'.repeat(11) }], ['strict', { other: 'x' }], ['say', { times: 9 }], ['say', { loud: 'true' }], ['say', { word: '-x ' }], ['say', 'not-an-object']] as const) {
    const p = await post(r, RUN_PREVIEW_PATH, src(name, args));
    assert.equal(p.status, 422, JSON.stringify([name, args]));
    const s = await post(r, RUN_START_PATH, { ...src(name, args), sha256: 'a'.repeat(64) });
    assert.equal(s.status, 422);
  }
  assert.equal((await post(r, RUN_PREVIEW_PATH, src('nope'))).status, 404);
});

test('the hash pins the argv: other args than the ones reviewed do not run', async () => {
  const r = await rig('pin');
  const p = await post(r, RUN_PREVIEW_PATH, src('strict', { word: 'one' }));
  assert.equal(p.json.command, '/bin/echo strict --word one');
  const s = await post(r, RUN_START_PATH, { ...src('strict', { word: 'two' }), sha256: p.json.sha256 });
  assert.equal(s.status, 409);
  assert.equal(s.json.error, 'changed');
  assert.equal(s.json.command, '/bin/echo strict --word two');
});

test('a script that can write needs the confirm flag', async () => {
  const r = await rig('confirm');
  const p = await post(r, RUN_PREVIEW_PATH, src('writer'));
  assert.equal(p.json.readOnly, false);
  const no = await post(r, RUN_START_PATH, { ...src('writer'), sha256: p.json.sha256 });
  assert.equal(no.status, 409);
  assert.equal(no.json.error, 'confirm');
  assert.equal((await runToEnd(r, 'writer', undefined, { confirm: true })).end.exitCode, 0);
});

test('one run per script at a time', async () => {
  const r = await rig('one');
  const p = await post(r, RUN_PREVIEW_PATH, src('slow'));
  const a = await post(r, RUN_START_PATH, { ...src('slow'), sha256: p.json.sha256 });
  assert.equal(a.status, 200);
  const b = await post(r, RUN_START_PATH, { ...src('slow'), sha256: p.json.sha256 });
  assert.equal(b.status, 409);
  assert.equal(b.json.error, 'busy');
  await post(r, '/api/run/kill', { runId: a.json.runId });
});
