/**
 * The Others' PRs tab's own writes: three POST routes, ignore, unignore and review-anyway (the guard and the per-start token run first, as for every write).
 * They only append a row to the actions file (lib/teammate/others-actions.ts); none of them reaches GitHub. The body names a PR by repo, number and head
 * sha, and the PR must be a row of the tab at that head right now, so a stale page cannot ignore the wrong commit. Review-anyway is for a hands-off row only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { actionsPath, ignorePr, isSha, requestReview, unignorePr } from '../teammate/others-actions.ts';
import type { OthersPrRow } from '../../web/client/src/types.ts';
import { sendError, sendJson } from './guard.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';

export const OTHERS_PATH = '/api/others';
export const OPS = ['ignore', 'unignore', 'review-anyway'] as const;
export type Op = typeof OPS[number];
export const OTHERS_WRITE_PATHS: ReadonlySet<string> = new Set(OPS.map((o) => `${OTHERS_PATH}/${o}`));
export const OTHERS_BODY_LIMIT = 2 * 1024;
export const OTHERS_BODY_LIMITS: ReadonlyMap<string, number> = new Map([...OTHERS_WRITE_PATHS].map((p) => [p, OTHERS_BODY_LIMIT]));

/** What the routes need beyond the shared write options: the rows the tab shows now (so a PR and head can be checked against them). */
export interface OthersWriteOptions extends WriteOptions { rows: () => OthersPrRow[] }

export interface Body { repo: string; pr: number; head?: string }
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;

/** The body in the exact shape the route takes (`unignore` has no head), or null. */
export function parseOthersBody(op: Op, body: unknown): Body | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(',');
  if (keys !== (op === 'unignore' ? 'pr,repo' : 'head,pr,repo')) return null;
  if (typeof r.repo !== 'string' || !REPO.test(r.repo) || !Number.isSafeInteger(r.pr) || (r.pr as number) <= 0) return null;
  if (op !== 'unignore' && !isSha(r.head)) return null;
  return { repo: r.repo, pr: r.pr as number, ...(op === 'unignore' ? {} : { head: r.head as string }) };
}

/** The message for a refused write, or null when it may go ahead. */
export function refusal(op: Op, b: Body, rows: readonly OthersPrRow[]): { status: number; message: string } | null {
  if (op === 'unignore') return null;
  const row = rows.find((x) => x.repo === b.repo && x.number === b.pr);
  if (!row) return { status: 404, message: 'That PR is not on the tab any more.' };
  if (row.headSha !== b.head) return { status: 409, message: 'The PR has new commits since this page was drawn. Reload and try again.' };
  if (op === 'review-anyway' && !row.handsOff) return { status: 422, message: 'Only a hands-off PR needs this: the others are reviewed on their own.' };
  return null;
}

/** Handles one Others' PRs POST that the guard let through. Always answers; never throws. */
export async function handleOthers(o: OthersWriteOptions, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const op = OPS.find((x) => path === `${OTHERS_PATH}/${x}`);
  if (!op) return sendError(res, 404);
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, OTHERS_BODY_LIMIT);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const body = parseOthersBody(op, parsed);
  if (!body) return sendError(res, 400);
  try {
    const bad = refusal(op, body, o.rows());
    if (bad) return sendJson(res, bad.status, { error: 'refused', message: bad.message });
    const file = actionsPath(o.web.vault, o.web.project);
    const key = `${body.repo}#${body.pr}`;
    if (op === 'ignore') ignorePr(file, key, body.head as string, o.now);
    else if (op === 'unignore') unignorePr(file, key, o.now);
    else requestReview(file, key, body.head as string, o.now);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
