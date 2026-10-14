/**
 * The Podium's draft-comment surface: `GET /api/drafts` and three POST routes, approve, edit and reject (the guard and the per-start token
 * run first, as for every write). Approve is the only route that can reach GitHub, and it does so through `approveAndPost` alone; edit and
 * reject only append a row. Every error body is a code and a message built here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { draftsPath, listDrafts, editDraft, rejectDraft, MAX_REASON, MAX_TEXT } from '../drafts/queue.ts';
import type { Draft, Outcome, Refusal } from '../drafts/queue.ts';
import { approveAndPost } from '../drafts/post.ts';
import type { GhRun } from '../drafts/post.ts';
import { sendError, sendJson } from './guard.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';

export const DRAFTS_PATH = '/api/drafts';
const OPS = ['approve', 'edit', 'reject'] as const;
type Op = typeof OPS[number];
export const DRAFT_WRITE_PATHS: ReadonlySet<string> = new Set(OPS.map((o) => `${DRAFTS_PATH}/${o}`));
/** Prose needs more room than the 2 KB the priorities edits get: the text plus JSON escaping. */
export const DRAFT_BODY_LIMIT = 24 * 1024;
export const DRAFT_BODY_LIMITS: ReadonlyMap<string, number> = new Map([...DRAFT_WRITE_PATHS].map((p) => [p, DRAFT_BODY_LIMIT]));

const STATUS: Record<Refusal, number> = { unknown: 404, state: 409, invalid: 422, changed: 409, busy: 409 };
const ID = /^dr-[0-9a-f]{8}$/;
const DAY = 86_400_000;
const RECENT_DONE = 30;

export interface DraftsWriteOptions extends WriteOptions { ghRun?: GhRun }

/** The wire shape of one draft. */
export interface DraftView { id: string; source: Draft['source']; repo: string; pr: number; prUrl: string; severity: Draft['severity']; text: string; where?: string; context?: string; replyTo?: string; state: Draft['state']; error?: string; postedUrl?: string; rejectReason?: string; createdAt: string }

const view = (d: Draft): DraftView => ({
  id: d.id, source: d.source, repo: d.repo, pr: d.pr, prUrl: `https://github.com/${d.repo}/pull/${d.pr}`, severity: d.severity, text: d.text,
  ...(d.target.kind === 'inline' ? { where: `${d.target.path}:${d.target.line}` } : {}),
  ...(d.context ? { context: d.context } : {}), ...(d.replyTo ? { replyTo: d.replyTo } : {}),
  state: d.state, ...(d.error ? { error: d.error } : {}), ...(d.postedUrl ? { postedUrl: d.postedUrl } : {}), ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}), createdAt: d.createdAt,
});

/** Everything waiting on the person, plus the last few decided drafts of the past week. Read-only. */
export function buildDrafts(o: { vault: string; project: string }, now: Date): { generatedAt: string; drafts: DraftView[] } {
  const all = listDrafts(draftsPath(o.vault, o.project));
  const open = all.filter((d) => d.state !== 'posted' && d.state !== 'rejected');
  const done = all.filter((d) => (d.state === 'posted' || d.state === 'rejected') && now.getTime() - Date.parse(d.updatedAt) < 7 * DAY).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_DONE);
  return { generatedAt: now.toISOString(), drafts: [...open, ...done].map(view) };
}

type Body = { id: string; text?: string; reason?: string };
/** The body as `{ id, text }` (approve, edit) or `{ id, reason }` (reject); null when it has any other shape. */
export function parseDraftBody(op: Op, body: unknown): Body | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const field = op === 'reject' ? 'reason' : 'text';
  if (Object.keys(rec).sort().join(',') !== [field, 'id'].sort().join(',')) return null;
  const v = rec[field];
  if (typeof rec.id !== 'string' || !ID.test(rec.id) || typeof v !== 'string' || v.length > (op === 'reject' ? MAX_REASON : MAX_TEXT) * 2) return null;
  return { id: rec.id, [field]: v };
}

function run(o: DraftsWriteOptions, op: Op, b: Body): Outcome<{ url?: string }> {
  const file = draftsPath(o.web.vault, o.web.project);
  const now = o.now;
  if (op === 'approve') return approveAndPost(file, b.id, b.text ?? '', { run: o.ghRun, now });
  if (op === 'edit') return editDraft(file, b.id, b.text ?? '', { now });
  return rejectDraft(file, b.id, b.reason ?? '', { now });
}

/** Handles one draft POST that the guard let through. Always answers; never throws. */
export async function handleDraft(o: DraftsWriteOptions, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const op = OPS.find((x) => path === `${DRAFTS_PATH}/${x}`);
  if (!op) return sendError(res, 404);
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, DRAFT_BODY_LIMIT);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const body = parseDraftBody(op, parsed);
  if (!body) return sendError(res, 400);
  try {
    const out = run(o, op, body);
    if (out.ok) return sendJson(res, 200, { ok: true, id: body.id, ...(out.url ? { url: out.url } : {}) });
    sendJson(res, STATUS[out.code], { error: out.code, message: out.message });
  } catch (e) {
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
