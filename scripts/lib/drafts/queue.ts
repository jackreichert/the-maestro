/**
 * The draft-comment queue: GitHub comments that are written but not yet posted, waiting for the person to approve, edit or reject them.
 *
 * Storage is an append-only JSONL file beside the ledger (`<ledger root>/Projects/<project>/Journal/drafts.jsonl`); the state of a draft is
 * the fold of its rows, so nothing is ever rewritten and every decision leaves a row. The one way a draft is created is `addDraft`, and it
 * always starts `pending`: no caller can hand in a state. The only rows that move a draft toward GitHub are `approve` (written by the
 * approve route in post.ts, after the person pressed Approve) and the rows post.ts writes around its single gh call.
 *
 * A row written by hand that `addDraft` would have refused (a bad repo, path, line or target) is dropped by the fold, so it is never shown and never posted.
 * States: pending -> approved -> posting -> posted | failed | uncertain; pending|failed|uncertain|stuck posting -> rejected.
 * `approved` with no `posting` row means the process died before gh was called, so approving again is safe. `failed` means gh said no, so nothing was posted and the person may approve again. `uncertain` means gh was cut off mid-call: the comment
 * may or may not exist, so it is never retried automatically (check GitHub, then reject it: reject is allowed from `uncertain`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export const MAX_TEXT = 4000;
export const MAX_REASON = 500;
export const MAX_REPLY_TO = 100;
export const MAX_PATH = 300;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type Severity = 'blocking' | 'suggestion' | 'reply';
export type Target =
  | { kind: 'inline'; path: string; line: number; commitId: string }
  | { kind: 'general' }
  | { kind: 'reply'; commentId: number };
export type DraftState = 'pending' | 'approved' | 'posting' | 'posted' | 'failed' | 'uncertain' | 'rejected';

/** What a producer supplies. There is no state field: a draft is always created pending. */
export interface NewDraft {
  /** Stable identity of the finding (PR, head, place, text hash), so adding the same one twice is a no-op, even after a reject. */
  key: string;
  /** `review`: a comment on someone else's PR. `reply`: an answer to someone else's comment on the person's own PR. */
  source: 'review' | 'reply';
  repo: string;
  pr: number;
  severity: Severity;
  text: string;
  target: Target;
  /** What the draft answers or why it exists: the comment being replied to, or the finding's one-line reason. Shown, never posted. */
  context?: string;
  /** Who wrote the comment a reply answers. */
  replyTo?: string;
}

export type Row =
  | ({ op: 'add'; id: string; ts: string } & NewDraft)
  | { op: 'edit'; id: string; ts: string; text: string }
  | { op: 'approve'; id: string; ts: string; text: string }
  | { op: 'uncertain'; id: string; ts: string }
  | { op: 'posting'; id: string; ts: string; nonce?: string }
  | { op: 'posted'; id: string; ts: string; url?: string }
  | { op: 'post-failed'; id: string; ts: string; error: string }
  | { op: 'reject'; id: string; ts: string; reason: string };

export interface Draft extends NewDraft {
  id: string; state: DraftState; createdAt: string; updatedAt: string;
  /** The text that was posted: set from approval on. */
  approvedText?: string; postingNonce?: string; postedUrl?: string; error?: string; rejectReason?: string;
}

export interface QueueOptions { now?: () => Date }

export const draftsPath = (vault: string, project: string): string => join(vault, 'Projects', project, 'Journal', 'drafts.jsonl');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The rows of the file; a line that is not a known row is skipped, never trusted. */
export function readRows(file: string): Row[] {
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (isObj(r) && typeof r.id === 'string' && typeof r.ts === 'string' && ['add', 'edit', 'approve', 'posting', 'uncertain', 'posted', 'post-failed', 'reject'].includes(String(r.op))) rows.push(r as Row);
    } catch { /* a torn line is skipped */ }
  }
  return rows;
}

/** A `posting` draft whose last row is older than the lock's stale age belongs to a process that died mid-call: its outcome is unknown, like `uncertain`. */
export const STUCK_MS = 120_000;
export const stuck = (d: { state: string; updatedAt: string }, now: string): boolean => d.state === 'posting' && Date.parse(now) - Date.parse(d.updatedAt) >= STUCK_MS;

/** True when a hand-written add row is a well-typed draft that addDraft would accept; anything that throws while being checked is not. */
function validRow(rest: unknown): boolean {
  try { return isObj(rest) && typeof rest.text === 'string' && typeof rest.key === 'string' && typeof rest.repo === 'string' && isObj(rest.target) && draftProblem(rest as unknown as NewDraft) === null; } catch { return false; }
}

/** Folds rows into drafts, oldest first. A row for an unknown id, or one the state does not allow, changes nothing. */
export function fold(rows: readonly Row[]): Draft[] {
  const byId = new Map<string, Draft>();
  for (const r of rows) {
    if (r.op === 'add') {
      if (byId.has(r.id)) continue;
      const { op: _op, id, ts, ...rest } = r;
      if (!validRow(rest)) continue;   // a row written by hand that add would have refused never becomes a draft
      byId.set(id, { ...rest, id, state: 'pending', createdAt: ts, updatedAt: ts });
      continue;
    }
    const d = byId.get(r.id);
    if (!d) continue;
    const editable = d.state === 'pending' || d.state === 'failed';
    if (r.op === 'edit' && editable) { d.text = r.text; d.state = 'pending'; delete d.error; }
    else if (r.op === 'approve' && (editable || d.state === 'approved')) { d.state = 'approved'; d.approvedText = r.text; delete d.error; }
    else if (r.op === 'posting' && d.state === 'approved') { d.state = 'posting'; d.postingNonce = r.nonce; }
    else if (r.op === 'uncertain' && d.state === 'posting') d.state = 'uncertain';
    else if (r.op === 'posted' && d.state === 'posting') { d.state = 'posted'; if (r.url) d.postedUrl = r.url; }
    else if (r.op === 'post-failed' && d.state === 'posting') { d.state = 'failed'; d.error = r.error; delete d.postingNonce; }
    else if (r.op === 'reject' && (editable || d.state === 'uncertain' || (d.state === 'posting' && stuck(d, r.ts)))) { d.state = 'rejected'; d.rejectReason = r.reason; }
    else continue;
    d.updatedAt = r.ts;
  }
  return [...byId.values()];
}

/** The text problem, or null: non-empty, bounded, no control characters. */
export function textProblem(text: string): string | null {
  if (!text.trim()) return 'The comment is empty.';
  if (text.length > MAX_TEXT) return `Keep the comment under ${MAX_TEXT} characters.`;
  if (CONTROL.test(text)) return 'The comment has control characters.';
  return null;
}

function targetProblem(t: unknown): string | null {
  if (!isObj(t)) return 'No target.';
  if (t.kind === 'general') return null;
  if (t.kind === 'reply') return Number.isSafeInteger(t.commentId) && (t.commentId as number) > 0 ? null : 'Bad comment id.';
  if (t.kind === 'inline') return typeof t.path === 'string' && t.path && t.path.length <= MAX_PATH && !t.path.startsWith('/') && !t.path.includes('..') && Number.isSafeInteger(t.line) && (t.line as number) > 0 && typeof t.commitId === 'string' && /^[0-9a-f]{7,64}$/.test(t.commitId) ? null : 'Bad inline target.';
  return 'Unknown target.';
}

/** The reason a new draft is refused, or null. */
export function draftProblem(d: NewDraft): string | null {
  if (typeof d.key !== 'string' || !d.key || d.key.length > 300) return 'Bad key.';
  if (d.replyTo !== undefined && (typeof d.replyTo !== 'string' || d.replyTo.length > MAX_REPLY_TO)) return 'Bad reply-to.';
  if (!REPO.test(d.repo) || !Number.isSafeInteger(d.pr) || d.pr <= 0) return 'Bad repo or PR number.';
  if (!['blocking', 'suggestion', 'reply'].includes(d.severity)) return 'Bad severity.';
  if (!['review', 'reply'].includes(d.source)) return 'Bad source.';
  if ((d.source === 'reply') !== (d.severity === 'reply')) return 'A reply has severity reply, and only a reply does.';
  if ((d.source === 'review' && d.target.kind === 'reply') || (d.source === 'reply' && d.target.kind === 'inline')) return 'A review comment cannot be a reply, and a reply cannot be inline.';
  return textProblem(d.text) ?? targetProblem(d.target);
}

const stamp = (o: QueueOptions): string => (o.now?.() ?? new Date()).toISOString();
const append = (file: string, row: Row): void => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(row)}\n`); };

/** The drafts as of now. */
export const listDrafts = (file: string): Draft[] => fold(readRows(file));

/** Adds a draft, always pending. Returns the existing draft's id when the key is already there (idempotent, even if it was rejected or posted). Throws on a bad draft. */
export function addDraft(file: string, d: NewDraft, o: { now?: () => Date } = {}): { id: string; created: boolean } {
  const problem = draftProblem(d);
  if (problem) throw new Error(`draft refused: ${problem}`);
  const existing = readRows(file).find((r): r is Extract<Row, { op: 'add' }> => r.op === 'add' && r.key === d.key);
  if (existing) return { id: existing.id, created: false };
  const id = `dr-${randomBytes(4).toString('hex')}`;
  append(file, { op: 'add', id, ts: stamp(o), key: d.key, source: d.source, repo: d.repo, pr: d.pr, severity: d.severity, text: d.text, target: d.target, ...(d.context ? { context: d.context.slice(0, 500) } : {}), ...(d.replyTo ? { replyTo: d.replyTo } : {}) });
  return { id, created: true };
}

export type Refusal = 'unknown' | 'state' | 'invalid' | 'changed' | 'busy';
export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; code: Refusal; message: string };
export const refuse = (code: Refusal, message: string): { ok: false; code: Refusal; message: string } => ({ ok: false, code, message });

/** Lock around read-decide-append, so two processes cannot both decide on the same draft. A lock older than two minutes belongs to a dead holder and is taken over. */
export function withLock<T>(file: string, fn: () => T): T | 'busy' {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const take = (): boolean => { try { mkdirSync(lock); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; } };
  if (!take()) {
    let age = 0;
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* released meanwhile */ }
    if (age < 120_000 || (rmSync(lock, { recursive: true, force: true }), !take())) return 'busy';
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function find(file: string, id: string): Draft | undefined { return listDrafts(file).find((d) => d.id === id); }

/** Replaces a pending (or failed) draft's text. */
export function editDraft(file: string, id: string, text: string, o: QueueOptions = {}): Outcome {
  const problem = textProblem(text);
  if (problem) return refuse('invalid', problem);
  const out = withLock(file, (): Outcome => {
    const d = find(file, id);
    if (!d) return refuse('unknown', 'No such draft.');
    if (d.state !== 'pending' && d.state !== 'failed') return refuse('state', `That draft is ${d.state}; it can no longer be edited.`);
    append(file, { op: 'edit', id, ts: stamp(o), text });
    return { ok: true };
  });
  return out === 'busy' ? refuse('busy', 'The queue is busy. Try again.') : out;
}

/** Records why a pending (or failed) draft will never be posted. Posts nothing. */
export function rejectDraft(file: string, id: string, reason: string, o: QueueOptions = {}): Outcome {
  const why = reason.replace(/\s+/g, ' ').trim();
  if (!why) return refuse('invalid', 'Say why, in a few words.');
  if (why.length > MAX_REASON || CONTROL.test(why)) return refuse('invalid', `Keep the reason under ${MAX_REASON} characters and plain text.`);
  const out = withLock(file, (): Outcome => {
    const d = find(file, id);
    if (!d) return refuse('unknown', 'No such draft.');
    if (d.state === 'posting' && !stuck(d, stamp(o))) return refuse('state', 'That draft is being posted right now. If it is still here in a couple of minutes, reject it then.');
    if (d.state !== 'pending' && d.state !== 'failed' && d.state !== 'uncertain' && d.state !== 'posting') return refuse('state', `That draft is ${d.state}; it cannot be rejected.`);
    append(file, { op: 'reject', id, ts: stamp(o), reason: why });
    return { ok: true };
  });
  return out === 'busy' ? refuse('busy', 'The queue is busy. Try again.') : out;
}

export { append as appendRow };
