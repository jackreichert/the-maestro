/**
 * Editing a stream's "What done looks like" from its page: `GET /api/streams/:name/done-text` (the section's raw markdown and a revision)
 * and `POST /api/done/save` (replace that section in the note it came from). Both go through `resolveTarget`, the one place a file is chosen.
 *
 * The page never names a path. It names a stream and one of the sources that stream's home base lists (an epic id or a project), and the
 * server re-derives that home (`buildHome`), checks the source is really in `done.sources` (the list `buildDone` read from), and only then
 * maps it to a note: an epic's ticket as `loadTickets` found it, or `Projects/<project>/CONTEXT.md`. A stream with no written source may
 * add the section to its first open epic (`kind: 'new'`). The note must also be a plain `.md` under `<vault_root>/Projects`, with no symlink on
 * the way and a realpath inside it. A save carries the revision the editor opened with and is refused (409) when the section changed since;
 * it replaces only that section, bumps the frontmatter date and writes through a temp file and a rename. guard.ts (same-origin JSON POST)
 * and the per-start token run first, like every other write.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DONE_TEXT_MAX, bumpUpdated, doneRev, doneTextProblem, readDoneSection, replaceDoneSection } from '../home/done-edit.ts';
import { localDate } from '../status-page/priorities.ts';
import { TICKET_DIR_SCOPES, TICKET_FILE_SCOPES, loadTickets } from '../vault/tickets.ts';
import { cleanPath, createReader } from '../vault/reader.ts';
import { hasSecretSegment } from '../vault/secret-names.ts';
import { buildHome } from './home.ts';
import { sendError, sendJson } from './guard.ts';
import { readBody, tokenOk, TOKEN_HEADER } from './priorities-write.ts';
import type { WriteOptions } from './priorities-write.ts';
import type { WebConfig } from './api.ts';

export const DONE_SAVE_PATH = '/api/done/save';
/** The text plus JSON escaping, with room for the stream, name and revision. */
export const DONE_BODY_LIMIT = 24 * 1024;
export const DONE_BODY_LIMITS: ReadonlyMap<string, number> = new Map([[DONE_SAVE_PATH, DONE_BODY_LIMIT]]);

const NOTE = /^Projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/(?:Tickets\/[^/]+|CONTEXT)\.md$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NOTE_BYTES = 256 * 1024;
const REV = /^[0-9a-f]{12}$/;

export type Kind = 'epic' | 'project' | 'new';
export interface Source { stream: string; kind: Kind; name: string }
type Refused = { ok: false; status: number; error: string; message: string };
const refuse = (status: number, error: string, message: string): Refused => ({ ok: false, status, error, message });

/** Resolves `vaultPath` (vault-relative) to a real file inside `<root>/Projects`, or null: plain path, known note shape, no symlink, realpath inside. */
export function safeNotePath(root: string, vaultPath: string): string | null {
  const segs = cleanPath(vaultPath);
  if (!segs || hasSecretSegment(vaultPath) || !NOTE.test(vaultPath)) return null;
  try {
    const realRoot = realpathSync(root);
    let cur = root;
    for (const s of segs) { cur = join(cur, s); if (lstatSync(cur).isSymbolicLink()) return null; }
    if (!statSync(cur).isFile() || statSync(cur).size > MAX_NOTE_BYTES) return null;
    const real = realpathSync(cur);
    return real.startsWith(join(realRoot, 'Projects') + sep) ? real : null;
  } catch { return null; }
}

/** The vault-relative note a source maps to, or a refusal. Only sources the stream's home base lists (or its first open epic, for `new`) are accepted. */
export function resolveTarget(cfg: WebConfig, src: Source, now: Date): { ok: true; path: string; file: string } | Refused {
  const root = cfg.vaultRoot;
  if (!root) return refuse(409, 'no-vault', 'No notes vault is configured, so there is nothing to edit.');
  const home = buildHome(cfg, src.stream, now);
  if (!home) return refuse(404, 'unknown', 'No such stream.');
  let path: string | null = null;
  if (src.kind === 'new') {
    if (home.done.sources.length) return refuse(409, 'exists', 'This stream already has a definition. Edit it instead.');
    const epic = home.epics.find((e) => e.status !== 'closed');
    if (!epic) return refuse(409, 'no-epic', 'This stream has no open epic to add the definition to.');
    path = ticketPath(root, epic.id);
  } else {
    if (!NAME.test(src.name) || !home.done.sources.some((s) => s.kind === src.kind && s.name === src.name)) return refuse(404, 'unknown', 'That definition is not one this stream reads.');
    path = src.kind === 'epic' ? ticketPath(root, src.name) : `Projects/${src.name}/CONTEXT.md`;
  }
  const file = path ? safeNotePath(root, path) : null;
  return path && file ? { ok: true, path, file } : refuse(404, 'unreadable', 'The note could not be found in the vault.');
}

function ticketPath(root: string, id: string): string | null {
  const reader = createReader({ root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES });
  const hits = loadTickets(reader, root).tickets.filter((t) => t.id === id);
  return hits.length === 1 && !hits[0]?.archived ? hits[0]?.path ?? null : null;   // a duplicated id is ambiguous: the page and the writer could pick different notes
}

export type TextOutcome = { ok: true; text: string; rev: string; path: string } | Refused;

/** The section's raw markdown and its revision, for the editor to open with. */
export function readDone(cfg: WebConfig, src: Source, now: Date): TextOutcome {
  const t = resolveTarget(cfg, src, now);
  if (!t.ok) return t;
  const note = readFileSync(t.file, 'utf8');
  return { ok: true, text: readDoneSection(note), rev: doneRev(note), path: t.path };
}

export type SaveOutcome = { ok: true; rev: string; path: string; created: boolean } | Refused;

/** Replaces the section in the note `src` maps to. Throws only on a disk failure; every refusal comes back as data. */
export function saveDone(cfg: WebConfig, src: Source, rev: string, text: string, now: Date): SaveOutcome {
  const problem = doneTextProblem(text);
  if (problem) return refuse(422, 'invalid', problem);
  const t = resolveTarget(cfg, src, now);
  if (!t.ok) return t;
  const note = readFileSync(t.file, 'utf8');
  if (doneRev(note) !== rev) return refuse(409, 'changed', 'This definition changed since you opened it. Reload the page and edit again.');
  const created = readDoneSection(note) === '';
  const next = bumpUpdated(replaceDoneSection(note, text), localDate(now, cfg.page.tz));
  const tmp = join(dirname(t.file), `.${randomBytes(6).toString('hex')}.done-edit.tmp`);
  try {
    writeFileSync(tmp, next, { flag: 'wx' });
    chmodSync(tmp, statSync(t.file).mode & 0o777);
    renameSync(tmp, t.file);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return { ok: true, rev: doneRev(next), path: t.path, created };
}

const KINDS: readonly Kind[] = ['epic', 'project', 'new'];
const STREAM_MAX = 200;

/** The body as a source, a revision and the text, or null for any other shape (a missing, extra or mistyped field; a name where `new` takes none). */
export function parseSave(body: unknown): { src: Source; rev: string; text: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  const keys = Object.keys(r).sort().join();
  if (keys !== (r.kind === 'new' ? 'kind,rev,stream,text' : 'kind,name,rev,stream,text')) return null;
  if (typeof r.stream !== 'string' || !r.stream || r.stream.length > STREAM_MAX || typeof r.text !== 'string' || r.text.length > DONE_TEXT_MAX * 2) return null;
  if (typeof r.rev !== 'string' || !REV.test(r.rev) || !KINDS.includes(r.kind as Kind)) return null;
  if (r.kind !== 'new' && typeof r.name !== 'string') return null;
  return { src: { stream: r.stream, kind: r.kind as Kind, name: r.kind === 'new' ? '' : (r.name as string) }, rev: r.rev, text: r.text };
}

/** The source named by a GET's query, or null. */
export function sourceFromQuery(stream: string, q: URLSearchParams): Source | null {
  const kind = q.get('kind');
  const name = q.get('name') ?? '';
  return KINDS.includes(kind as Kind) && (kind === 'new' ? name === '' : name !== '') ? { stream, kind: kind as Kind, name } : null;
}

/** Handles the save POST that the guard let through. Always answers; never throws. */
export async function handleDoneSave(o: WriteOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req.headers[TOKEN_HEADER], o.token)) { req.resume(); return sendError(res, 403); }
  const text = await readBody(req, DONE_BODY_LIMIT);
  if (text === null) return sendError(res, 413, { connection: 'close' });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return sendError(res, 400); }
  const body = parseSave(parsed);
  if (!body) return sendError(res, 400);
  try {
    const out = saveDone(o.web, body.src, body.rev, body.text, o.now());
    if (out.ok) return sendJson(res, 200, { ok: true, rev: out.rev, created: out.created });
    sendJson(res, out.status, { error: out.error, message: out.message });
  } catch (e) {
    o.log(e instanceof Error ? e.message.split('\n')[0] ?? 'error' : 'error');
    sendError(res, 500);
  }
}
