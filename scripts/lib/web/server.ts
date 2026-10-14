/**
 * The Podium server: GET endpoints over buildState/buildCharts and the client's static files, plus one narrow write surface.
 * `GET /api/events` is the one streaming route: Server-Sent Events from a shared watcher (events.ts), so the page updates without a reload.
 * The write surface is eight POST routes: three reorder, add and delete today's priorities (priorities-write.ts), one answers an ask (answer-write.ts), one refreshes the PR data (prs-refresh.ts), and three decide a drafted GitHub comment: approve (the only route that posts), edit, reject (drafts-write.ts).
 * They need a per-start token the page reads from `GET /api/edit-token`, and guard.ts only lets them through from the page's own origin.
 * Every request goes through guard.refuse first; every response is written by guard.send, so the security headers
 * are on 404s and 500s too. Every GET is read-only: nothing on a GET path writes the ledger, the priorities file or the page.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { buildRoutes, TYPES } from '../../web/serve-static.ts';
import { boardFiles, createChangeHub, serveEvents } from './events.ts';
import { vaultWatch } from './vault-watch.ts';
import type { ChangeHub } from './events.ts';
import { rawError, refuse, send, sendError, sendJson } from './guard.ts';
import { buildCharts, buildOpenPrs, buildState, buildStream } from './api.ts';
import type { WebConfig } from './api.ts';
import { buildEpics, buildHome } from './home.ts';
import { buildCost } from './cost.ts';
import { buildProjects } from './projects.ts';
import { withVerdicts } from './local-review.ts';
import { createLocalReviewCache, spawnProducer } from './local-review-cache.ts';
import { TOKEN_PATH, WRITE_PATHS as PRIORITY_PATHS, handleWrite } from './priorities-write.ts';
import { ANSWER_PATH, handleAnswer } from './answer-write.ts';
import { DRAFT_BODY_LIMITS, DRAFT_WRITE_PATHS, buildDrafts, handleDraft } from './drafts-write.ts';
import type { GhRun } from '../drafts/post.ts';
import { REFRESH_PATH, REFRESH_STATE_PATH, createRefresher, handleRefresh, spawnRebuild } from './prs-refresh.ts';
import type { Rebuild } from './prs-refresh.ts';
import { DEFAULT_PRIORITIES_MAX } from '../status-page/priorities.ts';

export interface WebServerOptions {
  web: WebConfig;
  clientDir: string;
  /** Atlassian tenant hosts (`<label>.atlassian.net`) whose ticket links may reuse a tab. Empty by default; the client re-validates each one. */
  trustedAtlassianHosts?: string[];
  /** Stream name to colour class (`s1`..`s8`, `so`) from the `podium_series` setting. Empty by default; the client re-validates each class. */
  namedSeries?: Record<string, string>;
  now?: () => Date;
  /** Where a handler's real error goes (the response only says "internal error"). */
  log?: (message: string) => void;
  /** Time to receive a whole request, and to receive its headers, in ms. */
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** How often the live-update watcher looks at the files (default 2000) and how often it sends a keep-alive (default 25000), in ms. */
  eventsIntervalMs?: number;
  eventsKeepAliveMs?: number;
  /** The change hub behind /api/events; tests pass their own to watch subscribers come and go. */
  hub?: ChangeHub;
  /** Produces the local review snapshot file (default: the snapshot script in a child process). Tests pass a fake. */
  localReviewScan?: (file: string) => Promise<void>;
  /** Age in ms after which the local review snapshot is refreshed in the background (default 120000). */
  localReviewStaleMs?: number;
  /** The page rebuild behind the Open PRs Refresh button (default: `status-page.ts` in a child process). Tests pass a fake. */
  prsRebuild?: Rebuild;
  /** Runs gh for an approved draft (default: the real gh). Tests pass a stub, so no test can reach GitHub. */
  ghRun?: GhRun;
  /** The write token. Default: 32 random bytes, new on every start; tests pass a known one. */
  token?: string;
}

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const EVENTS_PATH = '/api/events';
const MAX_HEADER_BYTES = 8 * 1024;

/** Every exact path that accepts POST: the three priorities edits, the answer to an ask, the PR refresh and the three draft-comment decisions. */
const WRITE_PATHS: ReadonlySet<string> = new Set([...PRIORITY_PATHS, ANSWER_PATH, REFRESH_PATH, ...DRAFT_WRITE_PATHS]);

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
  const containerRoot = o.web.containerRoot;
  // The queue is a snapshot another process writes; the route only reads it, so a slow scan never holds up a request.
  const localReview = createLocalReviewCache({ file: join(o.web.statusDir, 'local-review.json'), scan: o.localReviewScan ?? spawnProducer(containerRoot ?? ''), now, staleMs: o.localReviewStaleMs, log: o.log });
  return [
    { method: 'GET', pattern: /^\/api\/state$/, handler: () => buildState(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/streams\/([^/]+)$/, handler: (_u, m) => { const name = decodeName(m[1] ?? ''); return name === null ? undefined : buildStream(o.web, name, now()) ?? undefined; } },
    { method: 'GET', pattern: /^\/api\/streams\/([^/]+)\/home$/, handler: (_u, m) => { const name = decodeName(m[1] ?? ''); return name === null ? undefined : buildHome(o.web, name, now()) ?? undefined; } },
    { method: 'GET', pattern: /^\/api\/prs$/, handler: () => buildOpenPrs(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/drafts$/, handler: () => buildDrafts(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/epics$/, handler: () => buildEpics(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/cost$/, handler: () => buildCost(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/projects$/, handler: () => buildProjects(o.web, now()) },
    { method: 'GET', pattern: /^\/api\/local-review$/, handler: () => containerRoot
      ? withVerdicts(localReview.read(), o.web.vault)
      : { generatedAt: now().toISOString(), available: false, reason: 'No container folder is configured (set container_root), so local branches are not read.', units: [], more: 0, notes: [] } },
    { method: 'GET', pattern: /^\/api\/series$/, handler: () => ({ named: o.namedSeries ?? {} }) },
    { method: 'GET', pattern: /^\/api\/link-hosts$/, handler: () => ({ atlassian: o.trustedAtlassianHosts ?? [] }) },
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
  const vault = o.web.vaultRoot ? vaultWatch(o.web.vaultRoot) : null;
  const hub = o.hub ?? createChangeHub({ files: () => [...boardFiles(o.web.vault, o.web.project, o.web.statusDir), ...(vault ? vault.files() : [])], intervalMs: o.eventsIntervalMs, keepAliveMs: o.eventsKeepAliveMs });
  const token = o.token ?? randomBytes(32).toString('hex');
  const writes = { web: o.web, max: o.web.prioritiesMax ?? DEFAULT_PRIORITIES_MAX, token, now: (): Date => o.now?.() ?? new Date(), log, ghRun: o.ghRun };
  const refresher = createRefresher({ statusDir: o.web.statusDir, rebuild: o.prsRebuild ?? spawnRebuild({ statusDir: o.web.statusDir, vault: o.web.vault, project: o.web.project }), now: writes.now, log });
  const files = buildRoutes(o.clientDir);   // a whitelist taken at start: a request path is only ever looked up, never joined onto a path
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: o.requestTimeoutMs ?? 10_000, headersTimeout: o.headersTimeoutMs ?? 5_000, connectionsCheckingInterval: 1000 }, (req, res) => {
    try {
      const no = refuse(req, req.socket.localPort ?? 0, WRITE_PATHS, DRAFT_BODY_LIMITS);
      if (no) return sendError(res, no.status, no.headers);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST') {   // the guard let a POST through only for a write path
        (url.pathname === ANSWER_PATH ? handleAnswer(writes, req, res) : DRAFT_WRITE_PATHS.has(url.pathname) ? handleDraft(writes, url.pathname, req, res) : url.pathname === REFRESH_PATH ? handleRefresh(writes, refresher, req, res) : handleWrite(writes, url.pathname, req, res)).catch((e: unknown) => { log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error'); sendError(res, 500); });
        return;
      }
      if (url.pathname === TOKEN_PATH) return sendJson(res, 200, { token, max: writes.max }, false);
      if (url.pathname === REFRESH_STATE_PATH) return sendJson(res, 200, refresher.status());
      if (url.pathname === EVENTS_PATH) return serveEvents(req, res, hub);
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
