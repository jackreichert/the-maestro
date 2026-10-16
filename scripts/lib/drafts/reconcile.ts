/**
 * A failed review draft whose PR you already reviewed by hand should not keep inviting Approve (GitHub refuses the second one, HTTP 422).
 * `reconcileFailedReviews` finds those drafts and records `already-reviewed` for each, which the fold turns into a rejected draft with the reason.
 *
 * It makes no GitHub call unless a failed review draft exists, and it is run from the page rebuild, never from a page load: the web read of the queue stays a file read.
 * Only a review submitted by `self` after the draft was created counts; a pending (unsubmitted) review does not.
 */
import { appendRow, listDrafts, withLock } from './queue.ts';
import type { Draft } from './queue.ts';
import { spawnSync } from 'node:child_process';
import { toolCommand } from '../tool-bin.ts';

/** A read-only `gh` runner. Deliberately not imported from post.ts: only the approve route may import that module, and this one never writes to GitHub. */
export type GhRead = (args: string[]) => { status: number | null; stdout: string; stderr: string };
const spawnRead: GhRead = (args) => {
  const [cmd, argv] = toolCommand('gh', args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface ReconcileOptions { run?: GhRead; now?: () => Date }
export interface Reconciled { id: string; url?: string }

interface Review { user?: { login?: string } | null; state?: string; submitted_at?: string; html_url?: string }

/** The submitted reviews by `self` on the PR after `since`, newest last; null when GitHub cannot say. */
function reviewsBy(run: GhRead, repo: string, pr: number, self: string, since: string): Review[] | null {
  let r;
  try { r = run(['api', '--paginate', `repos/${repo}/pulls/${pr}/reviews`, '--jq', '.[] | tojson']); } catch { return null; }
  if (r.status !== 0) return null;
  const me = self.toLowerCase();
  const out: Review[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Review;
      if (v.user?.login?.toLowerCase() === me && v.state !== 'PENDING' && typeof v.submitted_at === 'string' && Date.parse(v.submitted_at) > Date.parse(since)) out.push(v);
    } catch { /* a line that is not a review is skipped */ }
  }
  return out.sort((a, b) => Date.parse(a.submitted_at as string) - Date.parse(b.submitted_at as string));
}

/** Records `already-reviewed` for every failed review draft whose PR has a review by `self` submitted after the draft was created. Returns the drafts it settled. */
export function reconcileFailedReviews(file: string, self: string, o: ReconcileOptions = {}): Reconciled[] {
  const failed = listDrafts(file).filter((d: Draft) => d.state === 'failed' && d.target.kind === 'review');
  if (!self.trim() || failed.length === 0) return [];
  const run = o.run ?? spawnRead;
  const settled: Reconciled[] = [];
  for (const d of failed) {
    const found = reviewsBy(run, d.repo, d.pr, self, d.createdAt);
    const hit = found?.[found.length - 1];
    if (!hit) continue;
    const url = typeof hit.html_url === 'string' && hit.html_url.startsWith('https://github.com/') ? hit.html_url : undefined;
    // Read the draft again under the lock: it may have been edited or rejected since the list above, and only a still-failed draft is settled.
    const wrote = withLock(file, () => {
      if (listDrafts(file).find((x) => x.id === d.id)?.state !== 'failed') return false;
      appendRow(file, { op: 'already-reviewed', id: d.id, ts: (o.now?.() ?? new Date()).toISOString(), ...(url ? { url } : {}) });
      return true;
    });
    if (wrote === true) settled.push({ id: d.id, ...(url ? { url } : {}) });
  }
  return settled;
}
