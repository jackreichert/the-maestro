// Run: node --test scripts/web/serve-static.test.ts
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECURITY_HEADERS, buildRoutes, createStaticServer } from './serve-static.ts';

const dir = mkdtempSync(join(tmpdir(), 'serve-static-'));
mkdirSync(join(dir, 'dist'));
mkdirSync(join(dir, 'fixtures'));
writeFileSync(join(dir, 'index.html'), '<p>home</p>');
writeFileSync(join(dir, 'theme.css'), 'body{}');
writeFileSync(join(dir, 'dist', 'app.js'), 'export {}');
writeFileSync(join(dir, 'dist', 'notes.txt'), 'not served');
writeFileSync(join(dir, 'fixtures', 'state.json'), '{}');
writeFileSync(join(dir, 'secret.json'), '{"no":1}');

const server = createStaticServer(dir);
let port = 0;
before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});
after(() => { server.close(); });

/** A hand-built request so Host and method are exactly what the test says. */
function get(path: string, opts: { host?: string; method?: string } = {}): Promise<{ status: number; type: string; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body, headers: res.headers }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('serves the index at / and /index.html, the theme, built files and fixtures', async () => {
  const home = await get('/');
  assert.deepEqual([home.status, home.type, home.body], [200, 'text/html; charset=utf-8', '<p>home</p>']);
  assert.equal((await get('/index.html')).status, 200);
  assert.equal((await get('/theme.css')).type, 'text/css; charset=utf-8');
  assert.equal((await get('/dist/app.js')).type, 'text/javascript; charset=utf-8');
  assert.equal((await get('/fixtures/state.json')).body, '{}');
});

test('does not serve unlisted files, other extensions, traversal or prototype names', async () => {
  for (const p of ['/secret.json', '/dist/notes.txt', '/dist/../secret.json', '/%2e%2e/secret.json', '/../secret.json', '/__proto__', '/constructor', '/api/state']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('refuses a foreign Host header (DNS rebinding) and non-GET methods', async () => {
  assert.equal((await get('/', { host: 'evil.test' })).status, 403);
  assert.equal((await get('/', { host: `127.0.0.1:${port + 1}` })).status, 403);
  assert.equal((await get('/', { host: `localhost:${port}` })).status, 200);
  assert.equal((await get('/', { method: 'POST' })).status, 405);
});

test('binds the loopback address only', () => {
  assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
});

test('buildRoutes tolerates a missing dist directory', () => {
  const bare = mkdtempSync(join(tmpdir(), 'serve-static-bare-'));
  writeFileSync(join(bare, 'index.html'), 'x');
  assert.deepEqual([...buildRoutes(bare).keys()].sort(), ['/', '/index.html']);
});

test('every response carries the security headers: pages, scripts, 404, 403 and 405', async () => {
  const csp = String(SECURITY_HEADERS['content-security-policy']);
  for (const res of [await get('/'), await get('/dist/app.js'), await get('/fixtures/state.json'), await get('/nope'), await get('/', { host: 'evil.test' }), await get('/', { method: 'POST' })]) {
    assert.equal(res.headers['content-security-policy'], csp, String(res.status));
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
});

test('the policy forbids inline script and style, remote origins, plugins, base tags, forms and framing', () => {
  const csp = SECURITY_HEADERS['content-security-policy'];
  for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-|\*|https?:|data:/.test(csp), 'no unsafe-inline, unsafe-eval, wildcard or remote source');
});
