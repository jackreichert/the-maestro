/**
 * Answering an ask from the page: the one POST route beside the priorities edits, `POST /api/asks/answer`.
 *
 * It records the answer the way `journal.ts resolve <id> --answer` does (`closeItem` appends the same `resolved` row), then
 * writes the answer into the ask's `> answer:` stub in The-Podium.md and into the status watcher's baseline copy of the page, so the note
 * shows the answer and the watcher reports no second event for it. An answer already typed in the note and not yet reported is
 * refused (it is waiting to be recorded; a second answer would double it), and so is an ask that is closed or does not exist.
 * guard.ts and the token check in priorities-write.ts run first; this module checks the body's shape and the ask itself.
 * The ledger row is the source of truth: if the note cannot be updated the answer still stands and the failure is logged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { closeItem } from '../journal/close.ts';
import { fold } from '../ledger-core.ts';
import { openStore } from '../journal/store.ts';
import { fillStub, extractFields, unprocessed } from '../status-page/inline.ts';
import { acquireLock, processAlive } from '../status-page/lock.ts';
import { PODIUM_FILE, readPodium, readSeenMeta, readSeenPage, writeAtomic, writeSeenPage } from '../status-page/seen.ts';
import { readBoard } from './api.ts';
import { MAX_BODY_BYTES, sendError, sendJson } from './guard.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';

export const ANSWER_PATH = '/api/asks/answer';
/** The longest answer, in characters; the guard's body limit would refuse a much longer one anyway. */
export const MAX_ANSWER = 1000;
/** What a skip is recorded as: the ask closes with no decision made, and the row says so. */
export const SKIP_TEXT = 'Skipped: no decision wanted on this one.';
const ID = /^[a-z0-9]{4,6}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type AnswerBody = { id: string; mode: 'text'; answer: string } | { id: string; mode: 'recommend' } | { id: string; mode: 'skip' };

/** The body as an `AnswerBody`, or null when it is not exactly one of the three shapes (a missing, extra or mistyped field). */
export function parseAnswer(body: unknown): AnswerBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const { id, mode } = rec;
  if (typeof id !== 'string' || !ID.test(id) || (mode !== 'text' && mode !== 'recommend' && mode !== 'skip')) return null;
  const keys = Object.keys(rec).sort().join(',');
  if (mode === 'recommend' || mode === 'skip') return keys === 'id,mode' ? ({ id, mode } as AnswerBody) : null;
  return keys === 'answer,id,mode' && typeof rec.answer === 'string' && rec.answer.length <= MAX_ANSWER * 2 ? { id, mode, answer: rec.answer } : null;
}

export type AnswerRefusal = 'invalid' | 'unknown' | 'answered' | 'pending' | 'busy';
export type AnswerOutcome = { ok: true; id: string; text: string } | { ok: false; code: AnswerRefusal; message: string };
const STATUS: Record<AnswerRefusal, number> = { invalid: 422, unknown: 404, answered: 409, pending: 409, busy: 409 };
const refuse = (code: AnswerRefusal, message: string): AnswerOutcome => ({ ok: false, code, message });

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** Another page rebuild holds the lock for up to a minute or two while it reads GitHub; wait briefly, then ask the person to retry. */
const LOCK_TIMING = { timeoutMs: 2000, staleMs: 30 * 60_000, pollMs: 100 };

/** The text an answer is recorded as, or the reason it cannot be. */
function answerText(req: AnswerBody, recommend: string | undefined): string | AnswerOutcome {
  if (req.mode === 'skip') return SKIP_TEXT;
  if (req.mode === 'recommend') return recommend ? `Take the recommendation: ${recommend}` : refuse('invalid', 'This ask has no recommendation to take.');
  const text = squash(req.answer);
  if (!text) return refuse('invalid', 'Write an answer first.');
  if (text.length > MAX_ANSWER || CONTROL.test(text)) return refuse('invalid', `Keep the answer under ${MAX_ANSWER} characters and plain text.`);
  return text;
}

/** Records one answer. Throws only on a ledger or disk failure; every refusal comes back as data. */
export function answerAsk(o: WriteOptions, req: AnswerBody): AnswerOutcome {
  const { statusDir } = o.web;
  let release: () => void;
  try { release = acquireLock(statusDir, { nowMs: () => Date.now(), sleep, pidAlive: processAlive, pid: process.pid }, LOCK_TIMING); } catch { return refuse('busy', 'The page is being rebuilt. Try again in a moment.'); }
  try {
    const { g } = readBoard(o.web, o.now());
    const ask = [...g.awaiting, ...g.paste].find((a) => a.id === req.id);
    if (!ask) return g.items.some((i) => i.id === req.id && (i.kind === 'question' || i.kind === 'decision') && i.closedBy) ? refuse('answered', 'That ask is already closed.') : refuse('unknown', 'No such ask is waiting for an answer.');
    const text = answerText(req, typeof ask.recommend === 'string' ? ask.recommend.trim() : undefined);
    if (typeof text !== 'string') return text;
    if (pendingInNote(statusDir, req.id)) return refuse('pending', 'That ask already has an answer typed in the note, waiting to be recorded.');
    const store = openStore({ vault: o.web.vault, project: o.web.project, dryRun: false, warn: o.web.warn ?? (() => {}) });
    const closed = closeItem({ readLedger: store.readLedger, append: store.append, newId: store.newId, fold: (entries) => fold(entries, store.loadRegistry()), today: () => o.now().toISOString().slice(0, 10), now: () => o.now().toISOString() },
      { kind: 'resolved', needle: req.id, note: text, skipIfClosed: true });
    if (closed.kind === 'already-closed') return refuse('answered', 'That ask is already closed.');
    if (closed.kind !== 'closed') return refuse('unknown', 'No such ask is waiting for an answer.');
    try { syncNote(statusDir, req.id, text); } catch (e) { o.log(`answered ask ${req.id} but could not update the note: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`); }
    return { ok: true, id: req.id, text };
  } finally { release(); }
}

/** Whether the note holds an answer for this ask that the status watcher has not reported yet. */
function pendingInNote(statusDir: string, id: string): boolean {
  const page = readPodium(statusDir);
  if (page === null) return false;
  const baseline = readSeenPage(statusDir);
  const meta = readSeenMeta(statusDir);
  return id in unprocessed(extractFields(page), baseline === null ? null : extractFields(baseline), meta ? meta.priorities_seen : undefined).answers;
}

/**
 * Put the answer in the note's stub and in the watcher's baseline, baseline first: the watcher reports an answer present in the page and
 * absent from the baseline, never the other way round. Skipped when either copy has no stub to fill (no baseline means every answer on the page
 * would read as new). If a rebuild or an edit changes the page meanwhile it starts over, then gives up.
 */
function syncNote(statusDir: string, id: string, text: string): void {
  const path = join(statusDir, PODIUM_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = readPodium(statusDir);
    const baseline = readSeenPage(statusDir);
    const filledPage = page === null ? null : fillStub(page, id, text);
    const filledBase = baseline === null ? null : fillStub(baseline, id, text);
    if (filledPage === null || filledBase === null) return;
    writeSeenPage(statusDir, filledBase);
    if (readPodium(statusDir) !== page) continue;   // changed while the baseline was written
    writeAtomic(path, filledPage);
    return;
  }
  throw new Error(`${PODIUM_FILE} kept changing`);
}

/** Handles the answer POST that the guard let through. Always answers; never throws. */
export async function handleAnswer(o: WriteOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const body = parseAnswer(parsed);
  if (!body) return sendError(res, 400);
  try {
    const out = answerAsk(o, body);
    if (out.ok) return sendJson(res, 200, { ok: true, id: out.id, answer: out.text });
    sendJson(res, STATUS[out.code], { error: out.code, message: out.message });
  } catch (e) {
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
