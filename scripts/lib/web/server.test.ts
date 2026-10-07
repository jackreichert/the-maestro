// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/server.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { sanitizeCharts, sanitizeState } from '../../web/client/src/contract.ts';
import { SECURITY_HEADERS } from './guard.ts';
import { createWebServer, dataRoutes } from './server.ts';
import type { WebServerOptions } from './server.ts';

const NOW = new Date('2026-10-06T15:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'web-server-'));
const client = join(root, 'client');
const vault = join(root, 'vault');
const statusDir = join(vault, 'Status');
for (const d of ['dist', 'fixtures']) mkdirSync(join(client, d), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
writeFileSync(join(client, 'theme.css'), 'body{}');
writeFileSync(join(client, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync(join(client, 'dist', 'app.js'), 'export {}');
writeFileSync(join(client, 'dist', 'notes.txt'), 'not served');
writeFileSync(join(client, 'fixtures', 'state.json'), '{}');
writeFileSync(join(root, 'secret.json'), '{"secret":"TOPSECRET"}');
openStore({ vault, project: 'p', dryRun: false }).append({ id: 'ask1', kind: 'question', text: 'Ship it? Context here.', stream: 'widgets', ts: '2026-10-06T12:00:00Z', date: '2026-10-06' });
const ledgerBefore = readFileSync(join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl'), 'utf8');

const logged: string[] = [];
const options: WebServerOptions = {
  web: { vault, project: 'p', statusDir, page: { streams: ['widgets'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' } },
  clientDir: client, now: () => NOW, log: (m) => logged.push(m),
};
const server = createWebServer(options);
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

interface Reply { status: number; body: string; headers: IncomingHttpHeaders }
/** A hand-built request: the path is sent as written (no normalisation) and Host is what the test says. */
function hit(path: string, opts: { method?: string; host?: string; headers?: Record<string, string> } = {}, target: Server = server): Promise<Reply> {
  const p = (target.address() as AddressInfo).port;
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: p, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${p}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', fail);
    req.end();
  });
}
const hasSecurityHeaders = (r: Reply): void => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[k], v, `${r.status} is missing ${k}`); };

/** Raw bytes on a socket, for requests the HTTP client would refuse to build. Resolves with what came back before the close. */
function raw(bytes: string): Promise<string> {
  return new Promise((ok) => {
    const s = connect(port, '127.0.0.1', () => s.write(bytes));
    let out = '';
    s.on('data', (c) => { out += c; });
    s.on('close', () => ok(out));
    s.on('error', () => ok(out));
    setTimeout(() => s.destroy(), 1500).unref();
  });
}

test('the server listens on the loopback address only', async () => {
  assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
  await assert.rejects(new Promise((ok, fail) => { const s = connect(port, '::1'); s.on('connect', ok); s.on('error', fail); }), 'nothing answers on ::1');
});

test('GET /api/state returns JSON that the client contract accepts with no dropped rows', async () => {
  const r = await hit('/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  const got = sanitizeState(JSON.parse(r.body));
  assert.ok(got);
  assert.equal(got.dropped, 0);
  assert.equal(got.state.asks[0]?.needed, 'Ship it?');
  assert.equal(got.state.generatedAt, NOW.toISOString());
  hasSecurityHeaders(r);
});

test('GET /api/charts honours and clamps days, and the payload passes the client contract', async () => {
  const days = async (q: string): Promise<number> => (JSON.parse((await hit(`/api/charts${q}`)).body) as { days: string[] }).days.length;
  assert.equal(await days(''), 14);
  assert.equal(await days('?days=3'), 3);
  assert.equal(await days('?days=0'), 1);
  assert.equal(await days('?days=9999'), 90);
  assert.equal(await days('?days=abc'), 14);
  const body = JSON.parse((await hit('/api/charts?days=2')).body);
  const { totals: _totals, ...prMix } = body.prMix;   // the reducers add PR totals the client contract does not carry
  assert.deepEqual(sanitizeCharts(body), { data: { ...body, prMix }, dropped: 0 });
});

test('GET /api/link-hosts is empty by default', async () => {
  const r = await hit('/api/link-hosts');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { atlassian: [] });
  assert.deepEqual(dataRoutes({ ...options, trustedAtlassianHosts: ['example.atlassian.net'] }).find((x) => x.pattern.test('/api/link-hosts'))?.handler(new URL('http://x/'), [] as unknown as RegExpMatchArray), { atlassian: ['example.atlassian.net'] });
});

test('GET /api/streams/:name filters one stream; an unknown, malformed or traversal name is 404', async () => {
  assert.equal((await hit('/api/streams/widgets')).status, 200);
  for (const bad of ['nope', '%E0%A4%A', '..%2F..%2Fsecret', '%2e%2e', 'widgets%2Fx']) {
    const r = await hit(`/api/streams/${bad}`);
    assert.equal(r.status, 404, bad);
    hasSecurityHeaders(r);
  }
});

test('every data route is GET, and every route and method but GET is refused', async () => {
  assert.ok(dataRoutes(options).every((r) => r.method === 'GET'));
  for (const path of ['/', '/api/state', '/api/charts', '/api/streams/widgets', '/nope']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const r = await hit(path, { method, headers: method === 'POST' ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` } : {} });
      assert.equal(r.status, 405, `${method} ${path}`);
      hasSecurityHeaders(r);
    }
  }
});

test('DNS rebinding: a foreign Host gets 403 and no data from every kind of route', async () => {
  for (const path of ['/', '/index.html', '/dist/app.js', '/api/state', '/api/charts', '/api/streams/widgets', '/nope']) {
    const r = await hit(path, { host: `attacker.example:${port}` });
    assert.equal(r.status, 403, path);
    assert.doesNotMatch(r.body, /Ship it|widgets|home/);
    hasSecurityHeaders(r);
  }
  assert.equal((await hit('/api/state', { host: `localhost:${port}` })).status, 200);
  assert.equal((await hit('/api/state', { host: '127.0.0.1' })).status, 403, 'no port is not the bound port');
});

test('a cross-origin request is refused and the server never sends CORS headers', async () => {
  const r = await hit('/api/state', { headers: { origin: 'https://attacker.example' } });
  assert.equal(r.status, 403);
  for (const path of ['/api/state', '/', '/nope']) assert.ok(!Object.keys((await hit(path)).headers).some((h) => h.startsWith('access-control-')), path);
});

test('static files: whitelist only, with content types and nosniff', async () => {
  const types: [string, string][] = [['/', 'text/html; charset=utf-8'], ['/index.html', 'text/html; charset=utf-8'], ['/theme.css', 'text/css; charset=utf-8'], ['/dist/app.js', 'text/javascript; charset=utf-8'], ['/fixtures/state.json', 'application/json; charset=utf-8'], ['/favicon.svg', 'image/svg+xml']];
  for (const [path, type] of types) {
    const r = await hit(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers['content-type'], type);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    hasSecurityHeaders(r);
  }
  assert.equal((await hit('/dist/notes.txt')).status, 404, 'an unlisted extension is not served');
});

test('path traversal never reaches a file outside the client directory', async () => {
  const attempts = ['/../secret.json', '/%2e%2e/secret.json', '/dist/../../secret.json', '/dist/%2e%2e/%2e%2e/secret.json', '/dist/..%2f..%2fsecret.json', '/dist/app.js/../../secret.json', '/secret.json', '/%00', '/dist/app.js%00.txt', '/dist\\..\\..\\secret.json'];
  for (const path of attempts) {
    const r = await hit(path);
    assert.ok([404, 400].includes(r.status), `${path} -> ${r.status}`);
    assert.doesNotMatch(r.body, /TOPSECRET/);
    hasSecurityHeaders(r);
  }
});

test('404 and 405 bodies are fixed JSON errors that name no path', async () => {
  const r = await hit('/nope/anything');
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
});

test('a handler that throws is a 500 with fixed text and the security headers; the detail goes only to the log', async () => {
  const boom = createWebServer({ ...options, now: () => { throw new Error(`failed reading ${root}/secret-ledger.jsonl at line 3`); }, log: (m) => logged.push(m) });
  await new Promise<void>((ok) => boom.listen(0, '127.0.0.1', ok));
  try {
    const r = await hit('/api/state', {}, boom);
    assert.equal(r.status, 500);
    assert.deepEqual(JSON.parse(r.body), { error: 'internal error' });
    assert.doesNotMatch(JSON.stringify(r), /secret-ledger|vault|\.ts|at line|\/tmp|\/var/);
    hasSecurityHeaders(r);
    assert.match(logged.join('\n'), /secret-ledger/);
  } finally { boom.close(); }
});

test('requests the parser rejects (oversize headers, a malformed line) still get the security headers', async () => {
  const big = await raw(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Pad: ${'a'.repeat(20_000)}\r\n\r\n`);
  assert.match(big, /^HTTP\/1\.1 431 /);
  assert.match(big, /content-security-policy: /i);
  const bad = await raw('NOT AN HTTP REQUEST\r\n\r\n');
  assert.match(bad, /^HTTP\/1\.1 400 /);
  assert.match(bad, /x-content-type-options: nosniff/i);
});

test('a client that never finishes its headers is cut off by the time limit', async () => {
  const slow = createWebServer({ ...options, headersTimeoutMs: 300, requestTimeoutMs: 300 });
  await new Promise<void>((ok) => slow.listen(0, '127.0.0.1', ok));
  try {
    const p = (slow.address() as AddressInfo).port;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const out = await new Promise<string>((ok) => {
      const s = connect(p, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
      let got = '';
      s.on('data', (c) => { got += c; });
      s.on('close', () => ok(got));
      s.on('error', () => ok(got));
      timer = setTimeout(() => s.destroy(), 6000);
    });
    clearTimeout(timer);
    assert.ok(Date.now() - started < 5500, 'closed by the server, not by the test timer');
    assert.match(out, /^HTTP\/1\.1 408 /);
    assert.match(out, /content-security-policy: /i);
  } finally { slow.close(); }
});

test('ledger warnings reach the log once, not once per request', async () => {
  const vault2 = mkdtempSync(join(tmpdir(), 'web-warn-'));
  mkdirSync(join(vault2, 'Projects', 'p', 'Journal'), { recursive: true });
  writeFileSync(join(vault2, 'Projects', 'p', 'Journal', 'ledger.jsonl'), 'garbage\n');
  const lines: string[] = [];
  const s = createWebServer({ ...options, web: { ...options.web, vault: vault2 }, log: (m) => lines.push(m) });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  try {
    await hit('/api/state', {}, s); await hit('/api/charts', {}, s);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /malformed line 1/);
  } finally { s.close(); }
});

test('the server never changes the ledger', () => {
  assert.equal(readFileSync(join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl'), 'utf8'), ledgerBefore);
});
