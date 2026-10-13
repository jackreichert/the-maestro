/** Whether an open PR is ready to merge. Pure, so the Open PRs tab and its test share one rule. */
import type { OpenPrRow } from './types.ts';

/**
 * Ready to merge needs all three, from the data the PR cache already holds (no live GitHub read):
 * approved (GitHub's decision over each reviewer's latest review; an empty decision is not an approval), no unresolved review
 * threads, and mergeable with no conflict ("unknown" is not mergeable). A draft is never ready.
 */
export function readyToMerge(p: Pick<OpenPrRow, 'isDraft' | 'review' | 'unresolved' | 'mergeable'>): boolean {
  return !p.isDraft && p.review === 'approved' && p.unresolved === 0 && p.mergeable === 'mergeable';
}
