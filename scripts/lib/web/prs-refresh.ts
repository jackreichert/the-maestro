/**
 * The Open PRs tab's Refresh button: `POST /api/prs/refresh` and `GET /api/prs/refresh-state`.
 *
 * A press does two things the status-refresh watcher already knows. It touches the PR-dirty marker (`.now-dirty-prs`, the watcher's own
 * trigger, so the watcher agrees the data is out of date) and it runs the same page rebuild the watcher runs (`status-page.ts`, the one
 * GitHub read there is), so the data is fresh in seconds and also when the loop is not running or it is quiet hours. The page lock
 * (`.now.lock`) already serialises rebuilds; its "already running" refusal is shown as such.
 *
 * One rebuild at a time: a press while one runs only reports it. The request takes no path and no argument (the body must be `{}`);
 * the child's arguments come from the server's own configuration. Error text sent to the page is fixed or a short reason, never a path.
 */
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { markPrsDirty } from '../status-page/dirty.ts';
import { MAX_BODY_BYTES, sendError, sendJson } from './guard.ts';
import { TOKEN_HEADER, readBody, tokenOk } from './priorities-write.ts';
import type { PrsRefreshStatus } from '../../web/client/src/types.ts';

export const REFRESH_PATH = '/api/prs/refresh';
export const REFRESH_STATE_PATH = '/api/prs/refresh-state';

const SCRIPT = fileURLToPath(new URL('../../status-page.ts', import.meta.url));
const REBUILD_TIMEOUT_MS = 180_000;
const MAX_REASON = 200;

/** One rebuild: resolves with what the child printed on stderr (a GitHub failure is reported there with exit 0), rejects with its stderr when it fails. */
export type Rebuild = () => Promise<{ stderr: string }>;

export interface RefresherOptions {
  statusDir: string;
  rebuild: Rebuild;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface Refresher { start(): PrsRefreshStatus; status(): PrsRefreshStatus }

/** The default rebuild: `status-page.ts` as a child, its arguments fixed from the server's configuration and killed after three minutes. */
export const spawnRebuild = (c: { statusDir: string; vault: string; project: string }): Rebuild => () => new Promise((ok, fail) => {
  execFile(process.execPath, [SCRIPT, '--status-dir', c.statusDir, '--vault', c.vault, '--project', c.project], { timeout: REBUILD_TIMEOUT_MS, killSignal: 'SIGKILL' }, (e, _out, stderr) => (e ? fail(Object.assign(e, { stderr })) : ok({ stderr })));
});

const errText = (e: unknown): string => (typeof e === 'object' && e !== null && typeof (e as { stderr?: unknown }).stderr === 'string' ? (e as { stderr: string }).stderr : e instanceof Error ? e.message : String(e));
const reason = (text: string, marker: RegExp): string => (text.split('\n').find((l) => marker.test(l)) ?? '').replace(/^status-page:\s*/, '').replace(/^GitHub read failed \((.*?)\);.*$/, '$1').slice(0, MAX_REASON);

/** What a finished rebuild means for the page. A GitHub failure exits 0 with a warning on stderr, so the text is what tells it apart from a refresh. */
function outcome(stderr: string): Pick<PrsRefreshStatus, 'state' | 'message'> {
  return /GitHub read failed/.test(stderr) ? { state: 'failed', message: `GitHub could not be read: ${reason(stderr, /GitHub read failed/)}. The table still shows the last cached PRs.` } : { state: 'done' };
}

function failure(e: unknown): Pick<PrsRefreshStatus, 'state' | 'message'> {
  const text = errText(e);
  if (/refresh is already running/.test(text)) return { state: 'locked', message: 'Another page refresh is already running. Try again in a moment.' };
  return { state: 'failed', message: 'The refresh failed. The table still shows the last cached PRs.' };
}

export function createRefresher(o: RefresherOptions): Refresher {
  const now = (): string => (o.now?.() ?? new Date()).toISOString();
  let current: PrsRefreshStatus = { state: 'idle' };
  let running = false;

  const finish = (result: Pick<PrsRefreshStatus, 'state' | 'message'>): void => {
    running = false;
    current = { ...result, startedAt: current.startedAt, finishedAt: now() };
  };

  function start(): PrsRefreshStatus {
    if (running) return current;
    running = true;
    current = { state: 'running', startedAt: now() };
    markPrsDirty(o.statusDir);
    o.rebuild().then(({ stderr }) => finish(outcome(stderr)), (e: unknown) => {
      o.log?.(`PR refresh failed: ${errText(e).split('\n')[0] ?? 'error'}`);
      finish(failure(e));
    });
    return current;
  }

  return { start, status: () => current };
}

/** Handles one POST that the guard let through: token, then a body of exactly `{}`, then the refresh. Always answers; never throws. */
export async function handleRefresh(o: { token: string }, refresher: Refresher, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return sendError(res, 400); }
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length > 0) return sendError(res, 400);
  const was = refresher.status().state === 'running';
  sendJson(res, was ? 409 : 202, { ...refresher.start(), ...(was ? { error: 'busy' } : {}) });
}
