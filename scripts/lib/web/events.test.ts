// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/events.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { boardFiles, createChangeHub } from './events.ts';
import { createWebServer } from './server.ts';

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const waitFor = async (ok: () => boolean, what: string, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await sleep(10); }
};

const root = mkdtempSync(join(tmpdir(), 'web-events-'));
const vault = join(root, 'vault');
const statusDir = join(vault, 'Status');
const client = join(root, 'client');
mkdirSync(statusDir, { recursive: true });
mkdirSync(client, { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
openStore({ vault, project: 'p', dryRun: false }).append({ id: 'ask1', kind: 'question', text: 'Ship it? Context here.', ts: '2026-10-06T12:00:00Z', date: '2026-10-06' });
const ledger = join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl');

test('boardFiles names every file the board reads, including the fragments that exist', () => {
  mkdirSync(join(statusDir, 'fragments'), { recursive: true });
  writeFileSync(join(statusDir, 'fragments', 'overview.md'), 'x');
  writeFileSync(join(statusDir, 'fragments', 'skip.txt'), 'x');
  const names = boardFiles(vault, 'p', statusDir).map((f) => f.slice(vault.length + 1));
  assert.deepEqual(names, [
    'Projects/p/Journal/ledger.jsonl', 'Projects/p/streams.json', 'Status/priorities.md', 'Status/.now-prs.json', 'Status/.now-dirty-prs',
    'Status/The-Podium.md', 'Status/ticket-map.json', 'Status/stream-overrides.json', 'Status/fragments/overview.md',
  ]);
});

test('the hub reports a changed stamp once with a seq, and says nothing while the files are unchanged', async () => {
  const f = join(root, 'watched.txt');
  writeFileSync(f, 'a');
  const hub = createChangeHub({ files: () => [f], intervalMs: 10, keepAliveMs: 60_000 });
  const seen: string[] = [];
  const off = hub.subscribe({ changed: (s) => seen.push(s), keepAlive: () => {} });
  await sleep(80);
  assert.deepEqual(seen, [], 'no change, no event');
  writeFileSync(f, 'bb');
  utimesSync(f, 5000, 5000);
  await waitFor(() => seen.length > 0, 'a change event');
  await sleep(80);
  assert.equal(seen.length, 1, 'one event per change');
  assert.match(seen[0] ?? '', /^[0-9a-f]{12}$/);
  off();
});

test('the hub sends keep-alives, and its timers run only while somebody is subscribed', async () => {
  const hub = createChangeHub({ files: () => [], intervalMs: 10, keepAliveMs: 10 });
  assert.equal(hub.running, false);
  let beats = 0;
  const a = hub.subscribe({ changed: () => {}, keepAlive: () => { beats += 1; } });
  const b = hub.subscribe({ changed: () => {}, keepAlive: () => {} });
  assert.equal(hub.running, true);
  assert.equal(hub.size, 2);
  await waitFor(() => beats >= 2, 'keep-alives');
  a();
  assert.equal(hub.running, true, 'one subscriber left');
  b();
  b();   // leaving twice is harmless
  assert.equal(hub.size, 0);
  assert.equal(hub.running, false);
});

// --- the HTTP route ---------------------------------------------------------------------------------------------
const hub = createChangeHub({ files: () => boardFiles(vault, 'p', statusDir), intervalMs: 15, keepAliveMs: 40 });
const server = createWebServer({
  web: { vault, project: 'p', statusDir, page: { streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' } },
  clientDir: client, hub, log: () => {},
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const port = (server.address() as AddressInfo).port;
after(() => { server.closeAllConnections(); server.close(); });

interface Stream { req: ClientRequest; res: IncomingMessage; text: () => string }
function open(headers: Record<string, string> = {}, path = '/api/events', method = 'GET'): Promise<Stream> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      ok({ req, res, text: () => body });
    });
    req.on('error', fail);
    req.end();
  });
}

test('GET /api/events opens an event stream with the security headers and emits changed when a watched file changes', async () => {
  const s = await open();
  assert.equal(s.res.statusCode, 200);
  assert.match(String(s.res.headers['content-type']), /^text\/event-stream/);
  assert.equal(s.res.headers['cache-control'], 'no-store');
  assert.equal(s.res.headers['x-content-type-options'], 'nosniff');
  assert.match(s.res.headers['content-security-policy'] as string, /default-src 'self'/);
  await sleep(100);
  assert.doesNotMatch(s.text(), /event: changed/, 'nothing changed yet');
  appendFileSync(ledger, JSON.stringify({ id: 'ask2', kind: 'question', text: 'Another? Yes.', ts: '2026-10-06T13:00:00Z', date: '2026-10-06' }) + '\n');
  await waitFor(() => /event: changed/.test(s.text()), 'a changed event');
  const m = /event: changed\ndata: (\{.*\})\n\n/.exec(s.text());
  assert.match(JSON.parse(m?.[1] ?? '{}').seq, /^[0-9a-f]{12}$/);
  await waitFor(() => /: keepalive/.test(s.text()), 'a keep-alive comment');
  s.req.destroy();
});

test('a new priorities file is noticed too; with no further change there is no further event', async () => {
  const s = await open();
  writeFileSync(join(statusDir, 'priorities.md'), '1. thing\n');
  await waitFor(() => (s.text().match(/event: changed/g) ?? []).length === 1, 'the first event');
  await sleep(120);
  assert.equal((s.text().match(/event: changed/g) ?? []).length, 1);
  s.req.destroy();
});

test('when the client disconnects its subscription is dropped, and the shared timers stop with the last one', async () => {
  const a = await open();
  const b = await open();
  await waitFor(() => hub.size === 2, 'two subscribers');
  a.req.destroy();
  await waitFor(() => hub.size === 1, 'one subscriber');
  assert.equal(hub.running, true);
  b.req.destroy();
  await waitFor(() => hub.size === 0, 'no subscribers');
  assert.equal(hub.running, false);
});

test('the guard runs first: a foreign Host, a foreign Origin, a cross-site fetch and any other method never get a stream', async () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['foreign Host', { host: `attacker.example:${port}` }, 'GET'],
    ['foreign Origin', { origin: 'http://attacker.example' }, 'GET'],
    ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 'GET'],
    ['POST', {}, 'POST'],
  ];
  for (const [name, headers, method] of cases) {
    const s = await open(headers, '/api/events', method);
    assert.ok([403, 405].includes(s.res.statusCode ?? 0), `${name}: ${s.res.statusCode}`);
    assert.doesNotMatch(String(s.res.headers['content-type']), /event-stream/, name);
    await sleep(20);
    assert.doesNotMatch(s.text(), /retry:|event:/, name);
    assert.equal(hub.size, 0, `${name} subscribed`);
  }
  const same = await open({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(same.res.statusCode, 200, 'a same-origin EventSource is accepted');
  same.req.destroy();
});
