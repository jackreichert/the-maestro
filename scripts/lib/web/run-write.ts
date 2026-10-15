/**
 * Running a reviewed command from the page: five POST routes, `/api/run/{preview,start,poll,kill,resolve}`.
 *
 * guard.ts has already refused anything that is not this page's own same-origin JSON POST. Each route here then checks the per-start edit token before it
 * reads the body, and takes only ids and hashes from the page, never command text: the server re-reads the command from the ledger (an ask's block file) or
 * the catalog, runs the guards on it every time, and runs it only when its sha256 is still the one the page was shown. The child runs in the runner
 * (run/runner.ts): one run per item, a timeout, a kill, output scrubbed. A finished run leaves one ledger row (ids, status, exit code, duration: never output).
 * `resolve` closes the ask with a result the server composes from its own record of the run.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openStore } from '../journal/store.ts';
import type { ExtraGuard } from '../run/command-guard.ts';
import type { Runner } from '../run/runner.ts';
import { sendError, sendJson } from './guard.ts';
import { answerAsk } from './answer-write.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';
import { resolveAsk } from './run-source.ts';
import type { Lookup, Resolved } from './run-source.ts';

export const RUN_PREVIEW_PATH = '/api/run/preview';
export const RUN_START_PATH = '/api/run/start';
export const RUN_POLL_PATH = '/api/run/poll';
export const RUN_KILL_PATH = '/api/run/kill';
export const RUN_RESOLVE_PATH = '/api/run/resolve';
export const RUN_WRITE_PATHS: ReadonlySet<string> = new Set([RUN_PREVIEW_PATH, RUN_START_PATH, RUN_POLL_PATH, RUN_KILL_PATH, RUN_RESOLVE_PATH]);
export const RUN_BODY_LIMIT = 2048;

export interface RunDeps extends WriteOptions {
  runner: Runner;
  extraGuard?: ExtraGuard;
  /** Resolves a source other than an ask (the script catalog). Absent: only asks run. */
  resolveOther?: (body: Record<string, unknown>) => Lookup | null;
}

type Body = Record<string, unknown>;
const ID = /^[a-z0-9]{4,6}$/;
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{24}$/;
const KEYS: Record<string, string[]> = {
  [RUN_PREVIEW_PATH]: [], [RUN_START_PATH]: ['sha256', 'confirm'], [RUN_POLL_PATH]: ['runId', 'since'], [RUN_KILL_PATH]: ['runId'], [RUN_RESOLVE_PATH]: ['runId'],
};
const SOURCE_KEYS = ['source', 'id', 'name', 'args'];

/** The body as an object whose keys are all ones this route takes, or null. */
function shape(path: string, v: unknown): Body | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const rec = v as Body;
  const allowed = path === RUN_PREVIEW_PATH || path === RUN_START_PATH ? [...SOURCE_KEYS, ...(KEYS[path] ?? [])] : KEYS[path] ?? [];
  return Object.keys(rec).every((k) => allowed.includes(k)) ? rec : null;
}

/** The item a source names, looked up fresh. An ask is `{source:'ask', id}`; anything else goes to the catalog. */
function lookup(d: RunDeps, b: Body): Lookup | null {
  if (b.source === 'ask') return typeof b.id === 'string' && ID.test(b.id) ? resolveAsk(d.web, b.id, d.now(), d.extraGuard) : null;
  return d.resolveOther?.(b) ?? null;
}

const bad = (res: ServerResponse): void => sendError(res, 400);
const fail = (res: ServerResponse, status: number, error: string, message: string, extra: object = {}): void => sendJson(res, status, { error, message, ...extra });
const secs = (ms: number | null): string => `${((ms ?? 0) / 1000).toFixed(1)}s`;

/** The preview the page reviews: the exact command, its hash, and every reason it will not run. */
export function previewOf(item: Resolved): object {
  return { ok: true, source: item.source, target: item.target, title: item.title, command: item.command, sha256: item.sha256, readOnly: item.readOnly, tier: item.tier, runnable: item.refusals.length === 0, refusals: item.refusals };
}

/** One ledger row for a finished run: who and what, never the output. A failure is logged, not raised. */
export function recordRun(o: Pick<WriteOptions, 'web' | 'now' | 'log'>, r: { source: string; target: string; sha256: string; status: string; exitCode: number | null; durationMs: number }): void {
  try {
    const store = openStore({ vault: o.web.vault, project: o.web.project, dryRun: false, warn: () => {} });
    const now = o.now();
    store.appendMany([{ id: store.newId(store.readLedger()), ts: now.toISOString(), date: now.toISOString().slice(0, 10), kind: 'run', text: `Podium ran ${r.source} ${r.target}: ${r.status}, exit ${r.exitCode ?? 'none'}, ${r.durationMs} ms`, runSource: r.source, runTarget: r.target, sha256: r.sha256, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs }]);
  } catch (e) {
    o.log(`could not record a run in the ledger: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
  }
}

async function start(d: RunDeps, b: Body, res: ServerResponse): Promise<void> {
  const found = lookup(d, b);
  if (!found) return bad(res);
  if (!found.ok) return fail(res, found.status, found.error, found.message);
  const item = found.item;
  if (typeof b.sha256 !== 'string' || !HASH.test(b.sha256)) return bad(res);
  if (item.refusals.length) return fail(res, 422, 'refused', 'This command will not run.', { refusals: item.refusals });
  if (b.sha256 !== item.sha256) return fail(res, 409, 'changed', 'The command changed after you reviewed it. Review it again.', previewOf(item));
  if (item.readOnly === false && b.confirm !== true) return fail(res, 409, 'confirm', 'This command can write. Confirm to run it.');
  const out = d.runner.start(item.key, { source: item.source, target: item.target, sha256: item.sha256 }, item.spec, item.timeoutMs);
  if (out.ok) return sendJson(res, 200, { ok: true, runId: out.runId });
  if (out.code === 'busy') return fail(res, 409, 'busy', 'This item is already running.');
  if (out.code === 'full') return fail(res, 409, 'busy', 'Too many runs are active. Wait for one to finish.');
  return fail(res, 500, 'spawn', 'The command could not be started.');
}

function resolveAskRun(d: RunDeps, runId: string, res: ServerResponse): void {
  const info = d.runner.info(runId);
  if (!info) return fail(res, 404, 'unknown', 'No such run.');
  if (info.source !== 'ask') return fail(res, 422, 'invalid', 'Only a run of an ask can answer it.');
  if (info.status === 'running') return fail(res, 409, 'running', 'The run is still going.');
  const tail = info.tail.replace(/\s+/g, ' ').trim().slice(-500);
  const text = `Ran on the Podium (${info.status}, exit ${info.exitCode ?? 'none'}, ${secs(info.durationMs)}).${tail ? ` Last output: ${tail}` : ''}`;
  const out = answerAsk(d, { id: info.target, mode: 'text', answer: text });
  if (out.ok) return sendJson(res, 200, { ok: true, id: out.id, answer: out.text });
  fail(res, 409, out.code, out.message);
}

/** Handles one run POST that the guard let through. Always answers; never throws. */
export async function handleRun(d: RunDeps, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req.headers[TOKEN_HEADER], d.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, RUN_BODY_LIMIT);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return bad(res); }
  const b = shape(path, parsed);
  if (!b) return bad(res);
  try {
    if (path === RUN_PREVIEW_PATH) {
      const found = lookup(d, b);
      if (!found) return bad(res);
      return found.ok ? sendJson(res, 200, previewOf(found.item)) : fail(res, found.status, found.error, found.message);
    }
    if (path === RUN_START_PATH) return await start(d, b, res);
    const runId = b.runId;
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) return bad(res);
    if (path === RUN_POLL_PATH) {
      const since = b.since === undefined ? 0 : b.since;
      if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) return bad(res);
      const v = d.runner.view(runId, since);
      return v ? sendJson(res, 200, { ok: true, ...v }) : fail(res, 404, 'unknown', 'No such run.');
    }
    if (path === RUN_KILL_PATH) return d.runner.kill(runId) ? sendJson(res, 200, { ok: true }) : fail(res, 409, 'not-running', 'That run is not running.');
    return resolveAskRun(d, runId, res);
  } catch (e) {
    d.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
