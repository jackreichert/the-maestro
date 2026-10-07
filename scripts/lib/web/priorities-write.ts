/**
 * The Podium's only write surface: reorder, add and delete today's priorities. Three POST routes, nothing else.
 *
 * guard.ts has already refused anything that is not this page's own same-origin JSON POST on one of these paths. This module
 * adds the two checks the guard cannot make: the per-start token (a header only a page that read `GET /api/edit-token` from
 * this server can carry) and the body's shape. An accepted edit goes to `editPriorities`, which re-reads `priorities.md`, applies
 * the one operation and writes it back atomically; the result and the cap come back so the page can show the real list. Every
 * error body is a code and a message built here (never a path, a stack or the request's own text).
 * A successful edit also leaves a one-line, already-closed note in the ledger, so the day's history shows it.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openStore } from '../journal/store.ts';
import { EditRefused, MAX_STREAM, MAX_TEXT, editPriorities } from '../status-page/priorities-edit.ts';
import type { Edit } from '../status-page/priorities-edit.ts';
import { localDate, readPriorities } from '../status-page/priorities.ts';
import { MAX_BODY_BYTES } from './guard.ts';
import { sendError, sendJson } from './guard.ts';
import type { WebConfig } from './api.ts';

export const TOKEN_PATH = '/api/edit-token';
export const TOKEN_HEADER = 'x-podium-token';
const ROUTES: Record<string, Edit['op']> = { '/api/priorities/move': 'move', '/api/priorities/add': 'add', '/api/priorities/delete': 'delete' };
/** The exact paths that accept POST; handed to the guard. */
export const WRITE_PATHS: ReadonlySet<string> = new Set(Object.keys(ROUTES));

const STATUS: Record<string, number> = { invalid: 422, conflict: 409, cap: 409, busy: 409 };
const MAX_INDEX = 999;

type Shape = Record<string, 'index' | 'text' | 'stream?'>;
const SHAPES: Record<Edit['op'], Shape> = {
  move: { from: 'index', to: 'index', text: 'text' },
  add: { text: 'text', stream: 'stream?' },
  delete: { index: 'index', text: 'text' },
};

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_INDEX;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** The body as an `Edit` for `op`, or null when it is not exactly the shape that op takes (a missing, extra or mistyped field). */
export function parseEdit(op: Edit['op'], body: unknown): Edit | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const shape = SHAPES[op];
  const rec = body as Record<string, unknown>;
  if (Object.keys(rec).some((k) => !Object.hasOwn(shape, k))) return null;
  for (const [key, kind] of Object.entries(shape)) {
    const v = rec[key];
    if (kind === 'index' ? !isIndex(v) : kind === 'text' ? !isText(v, MAX_TEXT * 2) : v !== undefined && !isText(v, MAX_STREAM)) return null;
  }
  return { op, ...rec } as Edit;
}

/** Constant-time comparison of the presented token with ours. */
function tokenOk(presented: string | string[] | undefined, token: string): boolean {
  if (typeof presented !== 'string' || presented.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

/** The request body as text, or null if it is longer than the limit or the connection failed. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { ok(null); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => ok(null));
  });
}

export interface WriteOptions {
  web: WebConfig;
  /** The cap on the list (`priorities_max`). */
  max: number;
  token: string;
  now: () => Date;
  log: (message: string) => void;
}

/** One closed note in the ledger saying what changed. A failure is logged, not raised: the file is the source of truth and is already written. */
function recordEdit(o: WriteOptions, summary: string): void {
  try {
    const store = openStore({ vault: o.web.vault, project: o.web.project, dryRun: false, warn: () => {} });
    const entries = store.readLedger();
    const now = o.now();
    const base = { ts: now.toISOString(), date: now.toISOString().slice(0, 10), text: `Podium priorities: ${summary}` };
    const note = { id: store.newId(entries), ...base, kind: 'note' };
    store.appendMany([note, { id: store.newId([...entries, note]), ...base, kind: 'resolved', closes: note.id }]);
  } catch (e) {
    o.log(`could not record the priorities edit in the ledger: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
  }
}

/** The state both success and refusal answer with, so the page shows what is really in the file. */
function snapshot(o: WriteOptions): { priorities: ReturnType<typeof readPriorities>; max: number } {
  return { priorities: readPriorities(o.web.statusDir, localDate(o.now(), o.web.page.tz)), max: o.max };
}

/** Handles one POST that the guard let through. Always answers; never throws. */
export async function handleWrite(o: WriteOptions, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const op = ROUTES[path];
  if (!op) return sendError(res, 404);
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const edit = parseEdit(op, parsed);
  if (!edit) return sendError(res, 400);
  try {
    const result = editPriorities(o.web.statusDir, localDate(o.now(), o.web.page.tz), edit, { max: o.max });
    recordEdit(o, result.summary);
    sendJson(res, 200, snapshot(o));
  } catch (e) {
    if (e instanceof EditRefused) return sendJson(res, STATUS[e.code] ?? 422, { error: e.code, message: e.message, ...snapshot(o) });
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
