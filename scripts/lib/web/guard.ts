/**
 * The checks every request to the Podium server passes before any route runs, and the one way a response is written.
 * Loopback only: the Host and Origin headers must name 127.0.0.1 or localhost on the bound port (the DNS-rebinding
 * defence: a rebound name arrives with the attacker's Host). GET is served everywhere and carries no body. POST is
 * accepted only on the exact paths the caller lists as write paths, and then only from this page itself: an Origin that
 * is the server's own (required, not optional), a same-origin fetch, a JSON content type (which a cross-origin page
 * cannot send without a preflight that this server never answers) and a small declared body. Every other method is 405.
 * The server sends no CORS headers at all, so a cross-origin page cannot read a response. Every response, errors
 * included, carries the security headers; error text is fixed per status and never names a path or a stack.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Sent on every response, errors included: no inline script or style, nothing cross-origin, no framing, no referrer. */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

export const MAX_URL_LENGTH = 2048;
const STATUS_TEXT: Record<number, string> = {
  400: 'bad request', 403: 'forbidden', 404: 'not found', 405: 'method not allowed', 408: 'request timeout', 409: 'conflict',
  413: 'body too large', 414: 'uri too long', 415: 'unsupported media type', 422: 'unprocessable', 431: 'headers too large', 500: 'internal error',
};

/** True when `host` is exactly the loopback address or `localhost` with the bound port. */
export const hostAllowed = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
const originAllowed = (origin: string, port: number): boolean => origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

/** The largest request body a write path accepts, in bytes. */
export const MAX_BODY_BYTES = 2048;
/** No write paths: the default, so a caller that lists none serves GET only. */
const NO_WRITES: ReadonlySet<string> = new Set();

/** A refusal: the status to answer with and any extra headers. Null means the request may proceed. */
export interface Refusal { status: number; headers?: Record<string, string> }

/** The checks only a write needs, on top of the shared ones: this page's own origin, a JSON body of a declared small size. */
function refuseWrite(req: IncomingMessage, port: number, path: string): Refusal | null {
  const origin = req.headers.origin;
  if (origin === undefined || !originAllowed(origin, port)) return { status: 403 };   // a write must say where it came from; no Origin is not good enough
  if (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') return { status: 403 };
  if ((req.url ?? '') !== path) return { status: 400 };   // no query string on a write
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return { status: 415 };
  if (req.headers['transfer-encoding'] !== undefined) return { status: 400, headers: { connection: 'close' } };
  const length = req.headers['content-length'];
  if (length === undefined || !/^\d{1,6}$/.test(length) || Number(length) === 0) return { status: 400, headers: { connection: 'close' } };
  if (Number(length) > MAX_BODY_BYTES) return { status: 413, headers: { connection: 'close' } };
  return null;
}

/**
 * The first check that fails, in a fixed order (host, origin, method, url, body), or null. `writePaths` are the exact
 * paths that accept POST; everything else, including GET on a write path, is refused with the method it does take.
 */
export function refuse(req: IncomingMessage, port: number, writePaths: ReadonlySet<string> = NO_WRITES): Refusal | null {
  if (!hostAllowed(req.headers.host, port)) return { status: 403 };
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin, port)) return { status: 403 };
  const site = req.headers['sec-fetch-site'];   // browsers omit Origin on simple cross-site GETs (an img tag, a no-cors fetch) but always send this
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403 };
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url;
  if (req.method === 'POST' && writePaths.has(path)) return refuseWrite(req, port, path);
  if (req.method !== 'GET' || writePaths.has(path)) return { status: 405, headers: { allow: writePaths.has(path) ? 'POST' : 'GET' } };
  if (url.length > MAX_URL_LENGTH) return { status: 414 };
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return { status: 400 };   // origin-form only: `//host/x` and `http://host/x` would be re-read as another host
  if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] ?? '0') !== '0') return { status: 400, headers: { connection: 'close' } };
  return null;
}

/** The only place a response is written: security headers first, so no path can leave them off. */
export function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra }).end(body);
}

/** Start an event stream: the security headers and the SSE content type, no length, the connection left open. `retry` tells the browser how long to wait before it reconnects. */
export function openStream(res: ServerResponse): void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 5000\n\n');
}

export const sendJson = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

/** An error response with fixed text for its status: never an exception message, a path or a stack. */
export function sendError(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify({ error: STATUS_TEXT[status] ?? 'error' }), 'application/json; charset=utf-8', extra);
}

/** The raw bytes of an error response, for sockets the HTTP parser rejected before any handler ran (oversize headers, a timeout). */
export function rawError(status: number): string {
  const body = JSON.stringify({ error: STATUS_TEXT[status] ?? 'error' });
  const head = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), connection: 'close' };
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n${Object.entries(head).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`;
}
