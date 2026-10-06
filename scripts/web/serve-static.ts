#!/usr/bin/env node
/**
 * serve-static: a tiny dev server for viewing the Podium client. Not the Podium API server (a later slice).
 *
 *   node scripts/web/serve-static.ts [--port 8787]
 *
 * Binds 127.0.0.1 only. Serves a whitelist taken from directory listings at start (index.html, theme.css, dist/*,
 * fixtures/*.json), so no request path is ever joined onto a filesystem path. Everything under /api answers 404, which
 * is what makes the client fall back to its bundled fixtures. Run `npm run build:web` first (`npm run web:static` does both).
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SECURITY_HEADERS, hostAllowed } from '../lib/web/guard.ts';

const CLIENT = fileURLToPath(new URL('./client/', import.meta.url));
export const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8' };

/** URL path to absolute file path for every servable file; request paths are only ever looked up here. */
export function buildRoutes(clientDir: string): Map<string, string> {
  const routes = new Map<string, string>();
  const add = (url: string, file: string): void => { if (Object.hasOwn(TYPES, extname(file))) routes.set(url, file); };
  const top = new Set(readdirSync(clientDir));
  if (top.has('index.html')) { add('/', join(clientDir, 'index.html')); add('/index.html', join(clientDir, 'index.html')); }
  if (top.has('theme.css')) add('/theme.css', join(clientDir, 'theme.css'));
  for (const dir of ['dist', 'fixtures']) {
    try {
      for (const name of readdirSync(join(clientDir, dir))) add(`/${dir}/${name}`, join(clientDir, dir, name));
    } catch {
      // dist/ is absent until the first build: only index.html and the fixtures are served
    }
  }
  return routes;
}

/** Create the server (not yet listening). Only Host values naming the loopback address and the bound port are answered. */
export function createStaticServer(clientDir: string): Server {
  const routes = buildRoutes(clientDir);
  return createServer((req, res) => {
    const headers = SECURITY_HEADERS;
    if (!hostAllowed(req.headers.host, req.socket.localPort ?? 0)) { res.writeHead(403, headers).end('forbidden'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end('method not allowed'); return; }
    const pathname = (req.url ?? '/').split('?')[0];
    const file = routes.get(pathname);
    if (!file) { res.writeHead(404, headers).end('not found'); return; }
    let body: Buffer;
    try { body = readFileSync(file); } catch { res.writeHead(404, headers).end('not found'); return; }
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function main(): void {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' } } });
  const server = createStaticServer(CLIENT);
  server.listen(Number(values.port), '127.0.0.1', () => console.log(`Podium client: http://127.0.0.1:${values.port}/`));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
