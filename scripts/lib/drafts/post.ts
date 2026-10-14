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
import { appendRow, listDrafts, refuse, textProblem, withLock } from './queue.ts';
import type { Draft, Outcome } from './queue.ts';

export interface GhResult { status: number | null; stdout: string; stderr: string }
/** Runs `gh` with these arguments. Tests pass a stub; production spawns the real one (through the MAESTRO_GH_BIN seam). */
export type GhRun = (args: string[]) => GhResult;

const GH_TIMEOUT_MS = 30_000;
export const spawnGh: GhRun = (args) => {
  const [cmd, argv] = toolCommand('gh', args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** The `gh api` call that posts this draft's text: an inline review comment, a reply in a review thread, or a plain PR comment. */
export function ghArgs(d: Draft, text: string): string[] {
  const base = `repos/${d.repo}`;
  const t = d.target;
  const body = ['-f', `body=${text}`];
  if (t.kind === 'inline') return ['api', '-X', 'POST', `${base}/pulls/${d.pr}/comments`, ...body, '-f', `commit_id=${t.commitId}`, '-f', `path=${t.path}`, '-F', `line=${t.line}`, '-f', 'side=RIGHT'];
  if (t.kind === 'reply') return ['api', '-X', 'POST', `${base}/pulls/${d.pr}/comments/${t.commentId}/replies`, ...body];
  return ['api', '-X', 'POST', `${base}/issues/${d.pr}/comments`, ...body];
}

const REFUSED = /\bHTTP 4\d\d\b/;
const firstLine = (s: string): string => s.split('\n')[0]?.slice(0, 200) ?? '';
function urlOf(stdout: string): string | undefined {
  try {
    const u = (JSON.parse(stdout) as { html_url?: unknown }).html_url;
    return typeof u === 'string' && u.startsWith('https://github.com/') ? u : undefined;
  } catch { return undefined; }
}

export interface PostOptions { run?: GhRun; now?: () => Date }

/** Approve this draft as the text shown and post it. The one posting path. */
export function approveAndPost(file: string, id: string, shownText: string, o: PostOptions = {}): Outcome<{ url?: string }> {
  const run = o.run ?? spawnGh;
  const ts = (): string => (o.now?.() ?? new Date()).toISOString();
  const out = withLock(file, (): Outcome<{ url?: string }> => {
    const d = listDrafts(file).find((x) => x.id === id);
    if (!d) return refuse('unknown', 'No such draft.');
    if (d.state !== 'pending' && d.state !== 'failed' && d.state !== 'approved') {
      return refuse('state', d.state === 'posted' ? 'That draft is already posted.' : d.state === 'uncertain' ? 'GitHub did not confirm the last attempt. Check the PR before doing anything else.' : `That draft is ${d.state}.`);
    }
    if (shownText !== d.text) return refuse('changed', 'The draft changed since you opened it. Reload and approve what you see.');
    const bad = textProblem(d.text);
    if (bad) return refuse('invalid', bad);
    appendRow(file, { op: 'approve', id, ts: ts(), text: d.text });
    const nonce = randomBytes(8).toString('hex');
    appendRow(file, { op: 'posting', id, ts: ts(), nonce });
    // The lock should make this the only writer; if it ever is not, gh runs only when the fold accepted THIS writer's posting row (the first one of the current attempt),
    // so what we check is exactly what the fold will honour when it reads our posted/failed row.
    if (listDrafts(file).find((x) => x.id === id)?.postingNonce !== nonce) return refuse('busy', 'Another approval of this draft is already running.');
    let r: GhResult;
    try { r = run(ghArgs(d, d.text)); } catch { r = { status: null, stdout: '', stderr: '' }; }
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
    appendRow(file, { op: 'post-failed', id, ts: ts(), error: firstLine(r.stderr) || 'gh failed' });
    return refuse('state', `GitHub refused it: ${firstLine(r.stderr) || 'gh failed'}. Nothing was posted.`);
  });
  return out === 'busy' ? refuse('busy', 'The queue is busy. Try again.') : out;
}
