/**
 * Commenting on a blocked item from the page: the one POST route `POST /api/blocked/comment`, beside the answer route and written the same way.
 *
 * Two modes, both from the Blocked list:
 *   `comment`  records Jack's comment on the item (a non-item `comment` row: `of`, `by: Jack`, `source: podium`); the item stays blocked.
 *   `unblock`  records the same comment, closes the block with a `resolved` row (the step `journal.ts resolve <id>` takes, which the gate report
 *              tells you to run), and opens a queued `wip` row for the same work, as `journal.ts queue "<text>"` would. That queued row is what
 *              the `chain-next` pickup (`queue-moving`) and the board pick up, and its text ends with the comment, so whoever starts it, and the
 *              brief written from it, carries Jack's words. The three rows are written in one append, so a crash cannot leave a closed block with
 *              no queued work behind it.
 * guard.ts and the token check in priorities-write.ts run first; this module checks the body's shape and the item itself. Every refusal is data.
 * Idempotent: the same comment on the same item is recorded once. A repeated Unblock with the same comment answers ok with `same: true` and the
 * queued row it made; an item closed any other way (or with another comment) is refused, and so is a comment on a closed block.
 * The comment is plain text, one line, capped, and scanned for secret and PHI shapes before it is written; a refusal never repeats the text.
 * The server stores its rows with no `window`: it has no Claude session (README, "Two windows on one ledger").
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fold, isOpen } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import { openStore } from '../journal/store.ts';
import { scanText } from '../secret-scan.ts';
import { MAX_BODY_BYTES, sendError, sendJson } from './guard.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';

export const BLOCKED_PATH = '/api/blocked/comment';
/** The longest comment, in characters. Four bytes each still fits the guard's body limit. */
export const MAX_COMMENT = 400;
/** Who the rows say wrote them, and where from. */
export const BY = 'Jack';
export const SOURCE = 'podium';
const ID = /^[a-z0-9]{4,6}$/;
/** C0 and C1 controls and the bidi overrides: none belong in a one-line comment that later lands in briefs and terminal output. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export type UnblockBody = { id: string; mode: 'unblock' | 'comment'; comment: string };

/** The body as an `UnblockBody`, or null when it is not exactly `{ id, mode, comment }` (a missing, extra or mistyped field). */
export function parseUnblock(body: unknown): UnblockBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const { id, mode, comment } = rec;
  if (typeof id !== 'string' || !ID.test(id) || (mode !== 'unblock' && mode !== 'comment')) return null;
  if (Object.keys(rec).sort().join(',') !== 'comment,id,mode') return null;
  return typeof comment === 'string' && comment.length <= MAX_COMMENT * 2 ? { id, mode, comment } : null;
}

export type UnblockRefusal = 'invalid' | 'unknown' | 'unblocked';
export type UnblockOutcome = { ok: true; id: string; mode: UnblockBody['mode']; comment: string; same: boolean; queued?: string } | { ok: false; code: UnblockRefusal; message: string };
const STATUS: Record<UnblockRefusal, number> = { invalid: 422, unknown: 404, unblocked: 409 };
const refuse = (code: UnblockRefusal, message: string): UnblockOutcome => ({ ok: false, code, message });

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The comment as it is recorded, or the reason it cannot be. */
function commentText(raw: string): string | UnblockOutcome {
  const text = squash(raw);
  if (!text) return refuse('invalid', 'Write a comment first.');
  if (text.length > MAX_COMMENT || CONTROL.test(text)) return refuse('invalid', `Keep the comment under ${MAX_COMMENT} characters and plain text.`);
  if (scanText(text).length > 0) return refuse('invalid', 'That comment looks like it holds a secret or personal data. Reword it.');
  return text;
}

/** The latest `comment` row on `id`, or undefined. */
const latestComment = (entries: LedgerRow[], id: string): LedgerRow | undefined => [...entries].reverse().find((e) => e.kind === 'comment' && e.of === id);

/** The row an earlier Unblock of `item` with this comment left behind, or undefined: a `resolved` row from this page that carries the `unblocked` mark. */
const earlierUnblock = (item: LedgerItem, text: string): LedgerRow | undefined => {
  const c = item.closedBy;
  return c && c.kind === 'resolved' && c.unblocked === true && c.source === SOURCE && c.text === text ? c : undefined;
};

/** Records one comment, or one comment and an unblock. Throws only on a ledger or disk failure; every refusal comes back as data. */
export function commentOnBlocked(o: WriteOptions, req: UnblockBody): UnblockOutcome {
  const text = commentText(req.comment);
  if (typeof text !== 'string') return text;
  const store = openStore({ vault: o.web.vault, project: o.web.project, dryRun: false, warn: o.web.warn ?? (() => {}) });
  const entries = store.readLedger();
  const item = fold(entries, store.loadRegistry()).items.find((i) => i.id === req.id && i.kind === 'blocked');
  if (!item) return refuse('unknown', 'No such blocked item.');
  const base = { id: req.id, mode: req.mode, comment: text };
  if (!isOpen(item)) {
    const before = req.mode === 'unblock' ? earlierUnblock(item, text) : undefined;
    if (!before) return refuse('unblocked', 'That item is no longer blocked.');
    const queued = entries.find((e) => e.kind === 'wip' && e.unblocks === req.id);
    return { ok: true, ...base, same: true, ...(queued?.id ? { queued: queued.id } : {}) };
  }
  const noted = latestComment(entries, req.id)?.text === text;
  if (req.mode === 'comment') {
    if (noted) return { ok: true, ...base, same: true };
    store.append(commentRow(store.newId(entries), o.now(), req.id, text, item));
    return { ok: true, ...base, same: false };
  }
  const when = o.now();
  const rows: LedgerRow[] = [];
  const add = (make: (id: string) => LedgerRow): string => { const row = make(store.newId([...entries, ...rows])); rows.push(row); return row.id as string; };
  if (!noted) add((id) => commentRow(id, when, req.id, text, item));
  add((id) => ({ ...stamp(id, when), kind: 'resolved', closes: req.id, text, by: BY, source: SOURCE, unblocked: true, repo: item.repo, ticket: item.ticket }));
  const queued = add((id) => ({ ...stamp(id, when), kind: 'wip', queued: true, unblocks: req.id, text: `${item.text ?? ''} -- ${BY}: ${text}`, by: BY, source: SOURCE, ...placement(item) }));
  store.appendMany(rows);
  return { ok: true, ...base, same: false, queued };
}

const stamp = (id: string, when: Date): Pick<LedgerRow, 'id' | 'ts' | 'date'> => ({ id, ts: when.toISOString(), date: when.toISOString().slice(0, 10) });
/** Where the queued work belongs: the stream, repo and ticket of the block it came from. The gate stays behind on the closed block. */
const placement = (item: LedgerItem): Partial<LedgerRow> => ({ ...(item.stream ? { stream: item.stream } : {}), ...(item.repo ? { repo: item.repo } : {}), ...(item.ticket ? { ticket: item.ticket } : {}) });
const commentRow = (id: string, when: Date, of: string, text: string, item: LedgerItem): LedgerRow => ({ ...stamp(id, when), kind: 'comment', of, text, by: BY, source: SOURCE, ...(item.stream ? { stream: item.stream } : {}) });

/** Handles the POST that the guard let through. Always answers; never throws. */
export async function handleBlocked(o: WriteOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const body = parseUnblock(parsed);
  if (!body) return sendError(res, 400);
  try {
    const out = commentOnBlocked(o, body);
    if (out.ok) return sendJson(res, 200, out);
    sendJson(res, STATUS[out.code], { error: out.code, message: out.message });
  } catch (e) {
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
