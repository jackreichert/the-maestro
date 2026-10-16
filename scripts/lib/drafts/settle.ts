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
export interface Settled { id: string; repo: string; pr: number; reason: string }

interface Login { login?: string; is_bot?: boolean }
interface View {
  state?: string; reviewDecision?: string; author?: Login | null; createdAt?: string;
  reviewRequests?: ({ login?: string } | null)[]; reviews?: ({ author?: Login | null; state?: string; submittedAt?: string; body?: string } | null)[]; commits?: ({ committedDate?: string } | null)[];
}

const FIELDS = 'state,reviewDecision,author,createdAt,reviewRequests,reviews,commits';

/** The PR's facts, or null when GitHub cannot say or the answer is not shaped like a PR. */
function read(run: GhRead, repo: string, pr: number, self: string): SettledFacts | null {
  let r;
  try { r = run(['pr', 'view', String(pr), '--repo', repo, '--json', FIELDS]); } catch { return null; }
  if (r.status !== 0) return null;
  let v: View;
  try { v = JSON.parse(r.stdout) as View; } catch { return null; }
  const state = v.state;
  if ((state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') || typeof v.author?.login !== 'string') return null;
  const reviews: SettledReview[] = (v.reviews ?? []).flatMap((x) => (x?.state && x.submittedAt ? [{ login: x.author?.login ?? '', bot: isBotAuthor({ login: x.author?.login, type: x.author?.is_bot ? 'Bot' : null }), state: x.state, at: x.submittedAt, body: x.body ?? '' }] : []));
  const dates = (v.commits ?? []).map((c) => c?.committedDate ?? '').filter(Boolean).sort();
  const headAt = dates[dates.length - 1];
  return {
    state, decision: v.reviewDecision || null, author: v.author.login, self, createdAt: v.createdAt ?? '', ...(headAt ? { headAt } : {}),
    requested: (v.reviewRequests ?? []).map((q) => q?.login).filter((l): l is string => !!l), reviews,
  };
}

/** Rejects every pending (or failed) review draft whose PR is settled. Returns the drafts it rejected. */
export function settleStaleDrafts(file: string, self: string, o: SettleOptions = {}): Settled[] {
  const open = listDrafts(file).filter((d: Draft) => d.source === 'review' && (d.state === 'pending' || d.state === 'failed'));
  const run = o.run ?? spawnRead;
  const byPr = new Map<string, Draft[]>();
  for (const d of open) byPr.set(`${d.repo}#${d.pr}`, [...(byPr.get(`${d.repo}#${d.pr}`) ?? []), d]);
  const out: Settled[] = [];
  for (const drafts of byPr.values()) {
    const first = drafts[0] as Draft;
    const facts = read(run, first.repo, first.pr, self);
    const why = facts ? settledReason(facts) : null;
    if (!why) continue;
    const reason = `Settled automatically: ${why.text}, so this review is not posted.`;
    for (const d of drafts) if (rejectDraft(file, d.id, reason, o.now ? { now: o.now } : {}).ok) out.push({ id: d.id, repo: d.repo, pr: d.pr, reason });
  }
  return out;
}
