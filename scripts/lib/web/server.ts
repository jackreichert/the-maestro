/**
 * The read-only Podium server: GET endpoints over buildState/buildCharts and the client's static files.
 * Every request goes through guard.refuse first; every response is written by guard.send, so the security headers
 * are on 404s and 500s too. Nothing here writes the ledger, the priorities file or the page.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { buildRoutes, TYPES } from '../../web/serve-static.ts';
import { rawError, refuse, send, sendError, sendJson } from './guard.ts';
import { buildCharts, buildState, buildStream } from './api.ts';
import type { WebConfig } from './api.ts';
import { buildHome } from './home.ts';

export interface WebServerOptions {
  web: WebConfig;
  clientDir: string;
  now?: () => Date;
  /** Where a handler's real error goes (the response only says "internal error"). */
  log?: (message: string) => void;
  /** Time to receive a whole request, and to receive its headers, in ms. */
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
}

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const MAX_HEADER_BYTES = 8 * 1024;

type Handler = (url: URL, match: RegExpMatchArray) => unknown;
interface Route { method: 'GET'; pattern: RegExp; handler: Handler }

/** Whole-number `days` from the query, default 14, clamped to 1..90. */
function daysParam(url: URL): number {
  const n = Number.parseInt(url.searchParams.get('days') ?? '', 10);
  return Number.isFinite(n) ? Math.min(MAX_DAYS, Math.max(1, n)) : DEFAULT_DAYS;
}

/** A path segment decoded, or null when it is not valid percent-encoding. */
function decodeName(segment: string): string | null {
  try { return decodeURIComponent(segment); } catch { return null; }
}

/** The data routes. Handlers return the JSON value, or undefined for "no such thing" (404). */
export function dataRoutes(o: WebServerOptions): Route[] {
  const now = (): Date => o.now?.() ?? new Date();
  return [
    { method: 'GET', pattern: /^\/api\/state$/, handler: () => buildState(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/streams\/([^/]+)$/, handler: (_u, m) => { const name = decodeName(m[1] ?? ''); return name === null ? undefined : buildStream(o.web, name, now()) ?? undefined; } },
    { method: 'GET', pattern: /^\/api\/streams\/([^/]+)\/home$/, handler: (_u, m) => { const name = decodeName(m[1] ?? ''); return name === null ? undefined : buildHome(o.web, name, now()) ?? undefined; } },
    { method: 'GET', pattern: /^\/api\/charts$/, handler: (u) => buildCharts(o.web, daysParam(u), now()) },
  ];
}

/** Create the server (not yet listening). Bind it to 127.0.0.1 only; the Host check needs the bound port. */
export function createWebServer(o: WebServerOptions): Server {
  const log = o.log ?? ((m: string) => console.error(`web: ${m}`));
  // Ledger and registry warnings (a malformed line) go to the log once each, not once per request.
  const warned = new Set<string>();
  const warn = o.web.warn ?? ((m: string): void => { if (!warned.has(m)) { warned.add(m); log(m.trim()); } });
  const routes = dataRoutes({ ...o, web: { ...o.web, warn } });
  const files = buildRoutes(o.clientDir);   // a whitelist taken at start: a request path is only ever looked up, never joined onto a path
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: o.requestTimeoutMs ?? 10_000, headersTimeout: o.headersTimeoutMs ?? 5_000, connectionsCheckingInterval: 1000 }, (req, res) => {
    try {
      const no = refuse(req, req.socket.localPort ?? 0);
      if (no) return sendError(res, no.status, no.headers);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = routes.find((r) => r.pattern.test(url.pathname));
      if (route) {
        const out = route.handler(url, url.pathname.match(route.pattern) as RegExpMatchArray);
        return out === undefined ? sendError(res, 404) : sendJson(res, 200, out);
      }
      const file = files.get(url.pathname);
      if (!file) return sendError(res, 404);
      return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
    } catch (e) {
      log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
      return sendError(res, 500);
    }
  });
  // Requests the parser rejects never reach the handler (oversize headers, malformed lines, a timeout): answer them here so the headers still go out.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (!socket.writable) { socket.destroy(); return; }
    socket.end(rawError(err.code === 'HPE_HEADER_OVERFLOW' ? 431 : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400));
  });
  return server;
}
