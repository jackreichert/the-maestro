/**
 * The one definition of "a draft PR was promoted to ready for review", shared by prs-snapshot --diff and the pr-watch
 * event type so the two cannot drift. Pure: callers hand in the previous and current isDraft.
 */

/** The wording both reports use after the PR key. */
export const DRAFT_PROMOTED = 'draft promoted to ready for review';

/** True only for a PR known to have been a draft that now is not; a PR with no previous state is never a promotion. */
export const isDraftPromoted = (was: { isDraft: boolean } | undefined, now: { isDraft: boolean }): boolean => Boolean(was?.isDraft) && !now.isDraft;
