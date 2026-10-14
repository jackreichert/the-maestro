/** Whether an open PR is ready to merge. Pure, so the Open PRs tab and its test share one rule. */
import type { OpenPrRow } from './types.ts';

/**
 * Ready to merge needs all of these, from the data the PR cache already holds (no live GitHub read):
 * approved (GitHub's decision over each reviewer's latest review; an empty decision is not an approval), no unresolved review
 * threads, mergeable with no conflict ("unknown" is not mergeable), CI not failing, and, for a staging PR in a develop-then-staging
 * repo, a develop twin that has merged (`waitsOnDevelop` is set until then, and when no twin was found). A draft is never ready.
 * A PR in a self-review repo (`selfReview`) is ready on its checks alone: CI passed and no conflict. Drafts, approvals and threads do not gate it
 * (same rule as `selfReviewNotReady` in lib/self-review.ts, which the client bundle cannot import).
 */
export function readyToMerge(p: Pick<OpenPrRow, 'isDraft' | 'review' | 'unresolved' | 'mergeable' | 'ci' | 'waitsOnDevelop'> & { selfReview?: boolean }): boolean {
  if (p.selfReview) return p.ci === 'SUCCESS' && p.mergeable !== 'conflicting';
  return !p.isDraft && !p.waitsOnDevelop && p.review === 'approved' && p.unresolved === 0 && p.mergeable === 'mergeable' && p.ci !== 'FAILURE' && p.ci !== 'ERROR';
}
