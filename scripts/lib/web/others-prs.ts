/**
 * The Others' PRs tab's data: every open teammate PR the cache holds (`.now-others-prs.json`, written by the status-page rebuild), newest activity first.
 * Reads the cache only, so a page load never reaches GitHub. Own PRs and self-review repos are left out here as well as at fetch time,
 * so a changed `self_review_repos` takes effect before the next rebuild. The review-draft status is joined by the page from the draft queue, which changes on its own.
 */
import { readOthersCache } from '../teammate/others.ts';
import type { OtherPr } from '../teammate/others.ts';
import { isSelfReview } from '../self-review.ts';
import { PR_STALE_MS } from './state.ts';
import type { OthersPrRow, OthersPrsData } from '../../web/client/src/types.ts';

const DAY_MS = 86_400_000;

export interface OthersScopeOptions { statusDir: string; owners: readonly string[]; selfRepos: readonly string[]; self: string }

const reviewOf = (decision: string | null): OthersPrRow['review'] => (decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes-requested' : 'review-required');

function row(p: OtherPr, self: string, now: Date): OthersPrRow {
  const opened = Date.parse(p.createdAt);
  return {
    repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, base: p.base, updatedAt: p.updatedAt,
    ...(Number.isFinite(opened) ? { ageDays: Math.max(0, Math.floor((now.getTime() - opened) / DAY_MS)) } : {}),
    youAsked: self !== '' && p.requested.some((r) => r.toLowerCase() === self.toLowerCase()),
    review: reviewOf(p.decision), unresolved: p.unresolved, copilotThreads: p.copilotThreads,
  };
}

export function buildOthersPrs(o: OthersScopeOptions, now: Date): OthersPrsData {
  const cache = readOthersCache(o.statusDir);
  const owners = new Set(o.owners.map((x) => x.toLowerCase()));
  const self = o.self.toLowerCase();
  const kept = (cache?.prs ?? [])
    .filter((p) => p.author.toLowerCase() !== self && owners.has((p.repo.split('/')[0] ?? '').toLowerCase()) && !isSelfReview(p.repo, o.selfRepos))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const fetchedAt = cache?.fetchedAt ?? null;
  const stale = !fetchedAt || now.getTime() - fetchedAt.getTime() > PR_STALE_MS;
  return {
    generatedAt: now.toISOString(),
    prData: { fetchedAt: fetchedAt ? fetchedAt.toISOString() : null, stale, ...(cache?.failure ? { failure: cache.failure } : {}) },
    total: kept.length, prs: kept.map((p) => row(p, o.self, now)),
  };
}
