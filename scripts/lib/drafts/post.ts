/**
 * The only place a draft reaches GitHub, and the only code that calls `gh` to write a comment: `approveAndPost`.
 *
 * It is called by exactly one thing, the Podium's approve route, which runs only on a token-bearing same-origin click. It will not post a
 * draft that is not `pending` (or `failed`, to retry after gh refused it), and it will not post text other than what the person was looking at:
 * the page sends the text it showed, and a draft edited since is refused as `changed`. The order is fixed and every step is a ledger row:
 * `approve` (with the exact text), `posting` (written BEFORE gh runs), then `posted`, `post-failed` or `uncertain`. A second approve finds
 * `posting`, `uncertain` or `posted` and refuses, so a comment is never posted twice, including after a crash between gh and the last row.
 * Even if two processes both held the lock (a stale lock taken over twice), only the writer whose `posting` row is first in the file for this draft calls gh. Reject and edit live in queue.ts and never import this module; the last test in queue.test.ts pins that nothing else calls it.
 */
import { spawnSync } from 'node:child_process';
import { toolCommand } from '../tool-bin.ts';
import { randomBytes } from 'node:crypto';
import { appendRow, eventOf, listDrafts, refuse, revOf, textProblem, withLock } from './queue.ts';
import type { Draft, Outcome, ReviewEvent } from './queue.ts';
import { fetchThreads } from '../replies/threads.ts';
import { checkApprove } from '../approve-guard.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GhResult { status: number | null; stdout: string; stderr: string }
/** Runs `gh` with these arguments. Tests pass a stub; production spawns the real one (through the MAESTRO_GH_BIN seam). */
export type GhRun = (args: string[], input?: string) => GhResult;

const GH_TIMEOUT_MS = 30_000;
export const spawnGh: GhRun = (args, input) => {
  const [cmd, argv] = toolCommand('gh', args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...(input === undefined ? {} : { input }) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** A `gh api` call: its arguments, and the JSON body it reads from stdin when it has one (a review, whose inline comments are an array). */
export interface GhCall { args: string[]; input?: string }

/** The call that posts this draft's text: an inline review comment, a reply in a review thread, a plain PR comment, or a whole review. */
export function ghCall(d: Draft, text: string, event?: ReviewEvent | 'COMMENT'): GhCall {
  const base = `repos/${d.repo}`;
  const t = d.target;
  const body = ['-f', `body=${text}`];
  if (t.kind === 'review' && d.review) {
    const input = JSON.stringify({ commit_id: t.commitId, event: event ?? eventOf(d.review), body: text, comments: d.review.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.text })) });
    return { args: ['api', '-X', 'POST', `${base}/pulls/${d.pr}/reviews`, '--input', '-'], input };
  }
  if (t.kind === 'inline') return { args: ['api', '-X', 'POST', `${base}/pulls/${d.pr}/comments`, ...body, '-f', `commit_id=${t.commitId}`, '-f', `path=${t.path}`, '-F', `line=${t.line}`, '-f', 'side=RIGHT'] };
  if (t.kind === 'reply') return { args: ['api', '-X', 'POST', `${base}/pulls/${d.pr}/comments/${t.commentId}/replies`, ...body] };
  return { args: ['api', '-X', 'POST', `${base}/issues/${d.pr}/comments`, ...body] };
}

const REFUSED = /\bHTTP 4\d\d\b/;
const firstLine = (s: string): string => s.split('\n')[0]?.slice(0, 200) ?? '';
const MAX_DETAIL = 280;

/**
 * Why GitHub refused, in its own words. `gh api` prints the error body as JSON on stdout and only "gh: <status text> (HTTP 422)" on stderr, so the
 * reason (`message`, and `errors[]` as strings or { resource, field, code, message }) is read from stdout. Falls back to stderr's first line.
 */
export function refusalDetail(r: { stdout: string; stderr: string }): string {
  let detail = '';
  try {
    const j = JSON.parse(r.stdout) as { message?: unknown; errors?: unknown };
    const errs = Array.isArray(j.errors) ? j.errors.map((e) => (typeof e === 'string' ? e : typeof e === 'object' && e !== null ? Object.values(e as Record<string, unknown>).filter((v) => typeof v === 'string').join(' ') : '')).filter(Boolean) : [];
    detail = [typeof j.message === 'string' ? j.message : '', ...errs].filter(Boolean).join(': ');
  } catch { /* not JSON: stderr alone */ }
  const head = firstLine(r.stderr);
  return (detail ? (head ? `${head} (${detail})` : detail) : head).replace(/\s+/g, ' ').slice(0, MAX_DETAIL);
}

/** The files changed between two commits, or null when GitHub cannot say (then the review is not re-pinned). */
function changedFiles(run: GhRun, repo: string, from: string, to: string): string[] | null {
  let r: GhResult;
  try { r = run(['api', `repos/${repo}/compare/${from}...${to}`, '--jq', '[.files[].filename]']); } catch { return null; }
  if (r.status !== 0) return null;
  try { const v: unknown = JSON.parse(r.stdout); return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null; } catch { return null; }
}

/** The PR's live head commit, or null when it cannot be read. */
function liveHead(run: GhRun, repo: string, pr: number): string | null {
  let r: GhResult;
  try { r = run(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']); } catch { return null; }
  const sha = r.stdout.trim().toLowerCase();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
function urlOf(stdout: string): string | undefined {
  try {
    const u = (JSON.parse(stdout) as { html_url?: unknown }).html_url;
    return typeof u === 'string' && u.startsWith('https://github.com/') ? u : undefined;
  } catch { return undefined; }
}

/** `asComment` posts an approving review as a COMMENT review: the way through when the approve guard (lib/approve-guard.ts) refuses the approval. */
export interface PostOptions { run?: GhRun; now?: () => Date; asComment?: boolean }

/** Approve this draft as the text shown and post it. The one posting path. */
export function approveAndPost(file: string, id: string, shownRev: string, o: PostOptions = {}): Outcome<{ url?: string }> {
  const run = o.run ?? spawnGh;
  const ts = (): string => (o.now?.() ?? new Date()).toISOString();
  const out = withLock(file, (): Outcome<{ url?: string }> => {
    const d = listDrafts(file).find((x) => x.id === id);
    if (!d) return refuse('unknown', 'No such draft.');
    if (d.state !== 'pending' && d.state !== 'failed' && d.state !== 'approved') {
      return refuse('state', d.state === 'posted' ? 'That draft is already posted.' : d.state === 'uncertain' ? 'GitHub did not confirm the last attempt. Check the PR before doing anything else.' : `That draft is ${d.state}.`);
    }
    if (shownRev !== revOf(d)) return refuse('changed', 'The draft changed since you opened it. Reload and approve what you see.');
    const bad = textProblem(d.text);
    if (bad) return refuse('invalid', bad);
    const approving = d.target.kind === 'review' && d.review !== undefined && eventOf(d.review) === 'APPROVE';
    if (o.asComment && !approving) return refuse('invalid', 'Only an approving review can be posted as a comment.');
    let toPost: Draft = d;
    let event: 'COMMENT' | undefined;
    if (approving && !o.asComment) {
      // The live rule, checked now and not at submit (lib/approve-guard.ts): the head is still the reviewed commit, every open bot thread was triaged by the review,
      // and a thread triaged blocking turns the approval into a COMMENT review. An approval is never re-pinned to a newer head: that would approve code nobody reviewed.
      const v = checkApprove(run, d.repo, d.pr, (d.target as { commitId: string }).commitId, d.review?.triage ?? []);
      if (!v.ok) return v.code.startsWith('head-') ? refuse('changed', v.code === 'head-moved' ? 'PR moved since this draft; re-prepare it. Nothing was posted.' : `${v.message} Try again.`) : refuse('copilot', `${v.message} Nothing was posted.`);
      if (v.event === 'COMMENT') event = 'COMMENT';
    } else if (d.target.kind === 'review') {
      if (o.asComment) event = 'COMMENT';
      // A review is pinned to the commit it was written against. When the PR has moved, GitHub refuses inline comments on a commit that is no longer the head (HTTP 422).
      // If the push touched none of the files the review comments on, the same comments still mean the same lines, so it is re-pinned to the head; otherwise it is refused and the draft stays pending.
      const head = liveHead(run, d.repo, d.pr);
      if (head === null) return refuse('changed', 'Could not read the PR\'s current head from GitHub, so nothing was posted. Try again.');
      if (!head.startsWith(d.target.commitId.toLowerCase())) {
        const touched = changedFiles(run, d.repo, d.target.commitId, head);
        const commented = new Set((d.review?.comments ?? []).map((c) => c.path));
        if (touched === null || touched.some((f) => commented.has(f))) return refuse('changed', 'PR moved since this draft; re-prepare it. Nothing was posted.');
        toPost = { ...d, target: { kind: 'review', commitId: head } };
      }
    }
    appendRow(file, { op: 'approve', id, ts: ts(), text: d.text, ...(event ? { event } : {}) });
    const nonce = randomBytes(8).toString('hex');
    appendRow(file, { op: 'posting', id, ts: ts(), nonce });
    // The lock should make this the only writer; if it ever is not, gh runs only when the fold accepted THIS writer's posting row (the first one of the current attempt),
    // so what we check is exactly what the fold will honour when it reads our posted/failed row.
    if (listDrafts(file).find((x) => x.id === id)?.postingNonce !== nonce) return refuse('busy', 'Another approval of this draft is already running.');
    let r: GhResult;
    try { const call = ghCall(toPost, d.text, event); r = run(call.args, call.input); } catch { r = { status: null, stdout: '', stderr: '' }; }
    if (r.status === 0) {
      const url = urlOf(r.stdout);
      appendRow(file, { op: 'posted', id, ts: ts(), ...(url ? { url } : {}) });
      return { ok: true, ...(url ? { url } : {}) };
    }
    // Only a definite refusal (an HTTP 4xx from GitHub) proves nothing was created. A timeout, a 5xx or a dropped connection may have created the comment after the request was sent, so retrying could post it twice.
    if (r.status === null || !REFUSED.test(r.stderr)) {
      appendRow(file, { op: 'uncertain', id, ts: ts() });
      return refuse('state', 'GitHub did not confirm it. The comment may or may not have posted; check the PR.');
    }
    const why = refusalDetail(r) || 'gh failed';
    appendRow(file, { op: 'post-failed', id, ts: ts(), error: why });
    return refuse('state', `GitHub refused it: ${why}. Nothing was posted.`);
  });
  return out === 'busy' ? refuse('busy', 'The queue is busy. Try again.') : out;
}

/** What `postBotReply` needs: the person's own PR, the thread to answer, and what to say. */
export interface BotReply { repo: string; pr: number; self: string; rootId: number; text: string; resolve: boolean }
export type BotOutcome = { ok: true; posted: boolean; resolved: boolean; url?: string; note?: string } | { ok: false; code: 'not-bot' | 'invalid' | 'unknown' | 'uncertain' | 'failed'; message: string };

/** Any `@` before a letter or digit, or an HTML entity that renders as `@`: GitHub may turn it into a mention, and a mention notifies a person. Refused wherever it appears, even in code. */
const MENTION = /@[A-Za-z0-9]|&#0*64;|&#x0*40;|&commat;/i;
const RESOLVE = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';

/**
 * The one place a reply is posted WITHOUT approval: to a thread whose every participant besides the person is a bot (Copilot, a security
 * scanner), fixing or declining with a reason and then resolving it. It does not trust its caller's classification: it reads the thread from
 * GitHub itself and refuses unless the thread is unresolved, on the person's own open PR, and bot-only. A thread with any human in it is
 * refused (`not-bot`), whatever was asked, so a person's comment can only ever reach GitHub through approveAndPost.
 * Idempotent: `<drafts dir>/bot-replies.jsonl` records each attempt (`posting` before gh, then `posted` or `failed`); a thread with the same last
 * comment is never answered twice, and a `posting` row with no outcome is `uncertain` and is not retried.
 */
export function postBotReply(file: string, r: BotReply, o: { run?: GhRun; now?: () => Date } = {}): BotOutcome {
  const run = o.run ?? spawnGh;
  const bad = textProblem(r.text) ?? (MENTION.test(r.text) ? 'A reply that goes out without approval cannot @-mention a person.' : null);
  if (bad) return { ok: false, code: 'invalid', message: bad };
  const out = withLock(join(dirname(file), 'bot-replies'), (): BotOutcome => {
    let pr;
    try { pr = fetchThreads(r.repo, r.pr, r.self, run); } catch (e) { return { ok: false, code: 'unknown', message: (e as Error).message }; }
    if (pr.author.toLowerCase() !== r.self.toLowerCase() || !pr.open) return { ok: false, code: 'unknown', message: 'That is not your own open PR.' };
    const t = pr.threads.find((x) => x.rootId === r.rootId);
    if (!t || !t.waitingOn) return { ok: false, code: 'unknown', message: 'No unresolved thread is waiting on you there.' };
    if (t.kind !== 'bot') return { ok: false, code: 'not-bot', message: 'A person is part of that thread, so the reply waits for your approval.' };
    const key = `${r.repo}#${r.pr}:${t.rootId}@${t.waitingOn.id}`;
    const log = join(dirname(file), 'bot-replies.jsonl');
    const rows = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as { op: string; key: string }]; } catch { return []; } }).filter((x) => x.key === key) : [];
    const last = rows[rows.length - 1]?.op;
    const ts = (): string => (o.now?.() ?? new Date()).toISOString();
    const write = (op: string, extra: object = {}): void => { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, `${JSON.stringify({ op, key, ts: ts(), ...extra })}\n`); };
    if (last === 'posting') return { ok: false, code: 'uncertain', message: 'An earlier reply to this thread was cut off; check GitHub before anything else.' };
    let url: string | undefined;
    if (last === 'posted') { /* already answered: only the resolve may remain */ } else {
      write('posting');
      let g: GhResult;
      try { g = run(['api', '-X', 'POST', `repos/${r.repo}/pulls/${r.pr}/comments/${t.rootId}/replies`, '-f', `body=${r.text}`]); } catch { g = { status: null, stdout: '', stderr: '' }; }
      if (g.status !== 0) {
        if (g.status !== null && REFUSED.test(g.stderr)) { write('failed', { error: firstLine(g.stderr) }); return { ok: false, code: 'failed', message: `GitHub refused it: ${firstLine(g.stderr)}` }; }
        return { ok: false, code: 'uncertain', message: 'GitHub did not confirm the reply; check the thread before anything else.' };
      }
      url = urlOf(g.stdout);
      write('posted', { ...(url ? { url } : {}) });
    }
    let resolved = false;
    let note: string | undefined;
    if (r.resolve) {
      const g = run(['api', 'graphql', '-f', `query=${RESOLVE}`, '-f', `id=${t.nodeId}`]);
      resolved = g.status === 0;
      if (!resolved) note = `replied, but the thread could not be resolved: ${firstLine(g.stderr)}`;
    }
    return { ok: true, posted: last !== 'posted', resolved, ...(url ? { url } : {}), ...(note ? { note } : {}) };
  });
  return out === 'busy' ? { ok: false, code: 'failed', message: 'The reply log is busy. Try again.' } : out;
}
