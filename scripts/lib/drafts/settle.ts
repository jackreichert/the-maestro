/**
 * A queued review draft on a PR that no longer needs a review should never be posted: `settleStaleDrafts` rejects it, recording why.
 * "No longer needs a review" is the Others' PRs tab's own rule (lib/teammate/settled.ts: merged, closed, approved at the head, or picked up by another reviewer
 * unless you were asked and have not reviewed), read for each PR that holds a pending review draft with one `gh pr view`. The tab's cache only holds open PRs,
 * so a merged or closed PR cannot be found there; this is the one place that sees it.
 *
 * It rejects through `rejectDraft`, so the draft keeps its row, its text and the reason (`Settled automatically: ...`) and the person can still read it. It posts
 * nothing and never touches a draft that is approved, posted, rejected or a reply. It runs from the page rebuild (status-page.ts), never from a page load, and a GitHub
 * failure for a PR leaves that PR's drafts as they were.
 */
import { listDrafts, rejectDraft } from './queue.ts';
import type { Draft } from './queue.ts';
import { spawnRead } from './reconcile.ts';
import type { GhRead } from './reconcile.ts';
import { isBotAuthor } from '../github-bots.ts';
import { settledReason } from '../teammate/settled.ts';
import type { SettledFacts, SettledReview } from '../teammate/settled.ts';

export interface SettleOptions { run?: GhRead; now?: () => Date }
export interface SettledDraft { id: string; repo: string; pr: number; reason: string }

interface Login { login?: string }
interface View {
  state?: string; reviewDecision?: string; author?: Login | null; createdAt?: string;
  reviewRequests?: ({ login?: string } | null)[]; commits?: ({ committedDate?: string } | null)[];
}
interface RestReview { user?: { login?: string; type?: string } | null; state?: string; submitted_at?: string; body?: string | null }

/** The PR's submitted reviews from the REST API, which (unlike `gh pr view`) says whether an author is a Bot; null when GitHub cannot say. */
function readReviews(run: GhRead, repo: string, pr: number): SettledReview[] | null {
  let r;
  try { r = run(['api', '--paginate', `repos/${repo}/pulls/${pr}/reviews`, '--jq', '.[] | tojson']); } catch { return null; }
  if (r.status !== 0) return null;
  const out: SettledReview[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line) as RestReview;
      if (x.state && x.submitted_at) out.push({ login: x.user?.login ?? '', bot: isBotAuthor({ login: x.user?.login, type: x.user?.type }), state: x.state, at: x.submitted_at, body: x.body ?? '' });
    } catch { /* a line that is not a review is skipped */ }
  }
  return out;
}

/** Inline review comments by people, as COMMENTED reviews carrying the comment text, so a reviewer who commented line by line without a review body still counts as having picked the PR up. Best effort: a failed read adds nothing. */
function readInlineComments(run: GhRead, repo: string, pr: number): SettledReview[] {
  let r;
  try { r = run(['api', '--paginate', `repos/${repo}/pulls/${pr}/comments`, '--jq', '.[] | tojson']); } catch { return []; }
  if (r.status !== 0) return [];
  const out: SettledReview[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line) as { user?: { login?: string; type?: string } | null; created_at?: string; body?: string | null };
      if (x.created_at && x.body?.trim()) out.push({ login: x.user?.login ?? '', bot: isBotAuthor({ login: x.user?.login, type: x.user?.type }), state: 'COMMENTED', at: x.created_at, body: x.body });
    } catch { /* a line that is not a comment is skipped */ }
  }
  return out;
}

const FIELDS = 'state,reviewDecision,author,createdAt,reviewRequests,commits';

/** The PR's facts, or null when GitHub cannot say or the answer is not shaped like a PR. */
export function readFacts(run: GhRead, repo: string, pr: number, self: string): SettledFacts | null {
  let r;
  try { r = run(['pr', 'view', String(pr), '--repo', repo, '--json', FIELDS]); } catch { return null; }
  if (r.status !== 0) return null;
  let v: View;
  try { v = JSON.parse(r.stdout) as View; } catch { return null; }
  const state = v.state;
  if ((state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') || typeof v.author?.login !== 'string') return null;
  const reviews = readReviews(run, repo, pr);
  if (!reviews) return null;
  const dates = (v.commits ?? []).map((c) => c?.committedDate ?? '').filter(Boolean).sort();
  const headAt = dates[dates.length - 1];
  return {
    state, decision: v.reviewDecision || null, author: v.author.login, self, createdAt: v.createdAt ?? '', ...(headAt ? { headAt } : {}),
    requested: (v.reviewRequests ?? []).map((q) => q?.login).filter((l): l is string => !!l), reviews: [...reviews, ...readInlineComments(run, repo, pr)],
  };
}

/** Rejects every pending (or failed) review draft whose PR is settled. Returns the drafts it rejected. */
export function settleStaleDrafts(file: string, self: string, o: SettleOptions = {}): SettledDraft[] {
  const open = listDrafts(file).filter((d: Draft) => d.source === 'review' && (d.state === 'pending' || d.state === 'failed'));
  const run = o.run ?? spawnRead;
  const byPr = new Map<string, Draft[]>();
  for (const d of open) byPr.set(`${d.repo}#${d.pr}`, [...(byPr.get(`${d.repo}#${d.pr}`) ?? []), d]);
  const out: SettledDraft[] = [];
  for (const drafts of byPr.values()) {
    const first = drafts[0] as Draft;
    const facts = readFacts(run, first.repo, first.pr, self);
    const why = facts ? settledReason(facts) : null;
    if (!why) continue;
    const reason = `Settled automatically: ${why.text}; this review is not posted.`;
    for (const d of drafts) if (rejectDraft(file, d.id, reason, o.now ? { now: o.now } : {}).ok) out.push({ id: d.id, repo: d.repo, pr: d.pr, reason });
  }
  return out;
}
