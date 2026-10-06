// Run: node --test scripts/lib/web/guard.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_URL_LENGTH, SECURITY_HEADERS, hostAllowed, rawError, refuse, sendError, sendJson } from './guard.ts';

// A server whose only logic is the guard: whatever it lets through answers 200.
const server = createServer((req, res) => {
  const no = refuse(req, (req.socket.localPort ?? 0));
  if (no) sendError(res, no.status, no.headers);
  else sendJson(res, 200, { ok: true });
});
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

/** A hand-built request so Host, Origin and the method are exactly what the test says (fetch would rewrite them). */
function hit(opts: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('hostAllowed accepts only the loopback address or localhost on the bound port', () => {
  assert.ok(hostAllowed('127.0.0.1:8000', 8000));
  assert.ok(hostAllowed('localhost:8000', 8000));
  for (const bad of [undefined, '', '127.0.0.1', '127.0.0.1:8001', 'evil.example:8000', '127.0.0.1.evil.example:8000', 'localhost:8000.evil.example', '[::1]:8000', '0.0.0.0:8000']) assert.equal(hostAllowed(bad, 8000), false, String(bad));
});

test('a rebound hostname is refused with 403 and no data', async () => {
  const r = await hit({ headers: { host: `evil.example:${port}` } });
  assert.equal(r.status, 403);
  assert.deepEqual(JSON.parse(r.body), { error: 'forbidden' });
});

test('an Origin that is not this server is refused; the server own origin, and no Origin, pass', async () => {
  assert.equal((await hit({ headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await hit({ headers: { origin: 'null' } })).status, 403);
  assert.equal((await hit({ headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await hit()).status, 200);
});

test('a browser-declared cross-site or same-site request is refused even with no Origin; same-origin and direct navigation pass', async () => {
  for (const site of ['cross-site', 'same-site']) assert.equal((await hit({ headers: { 'sec-fetch-site': site } })).status, 403, site);
  for (const site of ['same-origin', 'none']) assert.equal((await hit({ headers: { 'sec-fetch-site': site } })).status, 200, site);
});

test('every method but GET is 405 with Allow: GET, and no CORS header is ever sent', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE']) {
    const r = await hit({ method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET');
  }
  const preflight = await hit({ method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 403);
  assert.ok(!Object.keys(preflight.headers).some((h) => h.startsWith('access-control-')));
});

test('a GET that carries a body is refused', async () => {
  assert.equal((await hit({ headers: { 'content-length': '2' } })).status, 400);
  assert.equal((await hit({ headers: { 'transfer-encoding': 'chunked' } })).status, 400);
});

test('an over-long URL is 414', async () => {
  assert.equal((await hit({ path: `/${'a'.repeat(MAX_URL_LENGTH)}` })).status, 414);
});

test('only origin-form URLs pass: a double slash or an absolute URL is 400', async () => {
  assert.equal((await hit({ path: '//evil.example/api/state' })).status, 400);
  assert.equal((await hit({ path: 'http://evil.example/api/state' })).status, 400);
  assert.equal((await hit({ path: '/\\evil.example/api/state' })).status, 400);
});

test('success and every refusal carry the full security header set', async () => {
  const responses = [await hit(), await hit({ method: 'POST' }), await hit({ headers: { host: 'evil.example' } }), await hit({ path: `/${'a'.repeat(MAX_URL_LENGTH)}` })];
  for (const r of responses) for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[k], v, `${r.status} ${k}`);
});

test('error text is fixed per status and never an exception message', () => {
  assert.match(rawError(500), /^HTTP\/1\.1 500 internal error\r\n/);
  assert.match(rawError(431), /content-security-policy: /);
  assert.ok(rawError(404).endsWith('{"error":"not found"}'));
});
