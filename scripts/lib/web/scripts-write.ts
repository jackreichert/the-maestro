/**
 * The Scripts tab's data and its one write: `GET /api/scripts` and `POST /api/scripts/ran` ("Mark done (I ran it)").
 *
 * The scripts are the registry's entries folded with the ledger (lib/scripts/view.ts). Their commands are shown verbatim and are never executed here:
 * the Run button on a script's ask goes through the reviewed-run route (run-write.ts), which re-reads the block file and applies the command guard.
 * The ran route takes only a script id. It records that the person ran the command themselves and, when the script's ask is still open, closes it with
 * a sentence composed here (never text from the page). A one-time script that is already finished is refused; a reusable one may be marked again.
 * guard.ts (same-origin JSON POST) and the per-start token run first, like every other write.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openStore } from '../journal/store.ts';
import { isScriptId, recordRan } from '../scripts/registry.ts';
import { markRefusal, viewsFor } from '../scripts/view.ts';
import type { ScriptView } from '../scripts/view.ts';
import { answerAsk } from './answer-write.ts';
import { MAX_BODY_BYTES, sendError, sendJson } from './guard.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';

export const SCRIPTS_RAN_PATH = '/api/scripts/ran';

/** Every script, blocked first, with its state; read-only. */
export function buildScripts(web: { vault: string; project: string; warn?: (m: string) => void }, now: Date): { generatedAt: string; scripts: ScriptView[] } {
  const store = openStore({ vault: web.vault, project: web.project, dryRun: false, warn: web.warn ?? (() => {}) });
  return { generatedAt: now.toISOString(), scripts: viewsFor(store, web) };
}

export type RanOutcome = { ok: true; id: string; resolvedAsk: boolean } | { ok: false; status: number; error: string; message: string };
const refuse = (status: number, error: string, message: string): RanOutcome => ({ ok: false, status, error, message });

/** Marks one script as run by the person. Throws only on a ledger or disk failure; every refusal comes back as data. */
export function markRan(o: WriteOptions, id: string): RanOutcome {
  const view = buildScripts(o.web, o.now()).scripts.find((s) => s.id === id);
  if (!view) return refuse(404, 'unknown', 'No such script.');
  const why = markRefusal(view);
  if (why) return refuse(409, 'finished', why);
  let resolvedAsk = false;
  if (view.askOpen) {
    // The ask first: if it cannot close (the page is being rebuilt) nothing is recorded and the button can be pressed again.
    const out = answerAsk(o, { id: view.ask, mode: 'text', answer: `Marked done: ran it myself (${view.title}).` });
    if (out.ok) resolvedAsk = true;
    else if (out.code !== 'answered') return refuse(409, out.code, out.message);
  }
  recordRan({ vault: o.web.vault, project: o.web.project, id, result: 'done', via: 'podium', now: o.now() });
  return { ok: true, id, resolvedAsk };
}

/** Handles the ran POST that the guard let through. Always answers; never throws. */
export async function handleScriptRan(o: WriteOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const rec = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!rec || Object.keys(rec).join() !== 'id' || !isScriptId(rec.id)) return sendError(res, 400);
  try {
    const out = markRan(o, rec.id);
    if (out.ok) return sendJson(res, 200, { ok: true, id: out.id, resolvedAsk: out.resolvedAsk });
    sendJson(res, out.status, { error: out.error, message: out.message });
  } catch (e) {
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
