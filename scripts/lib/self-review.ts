/**
 * Self-review repos (`self_review_repos`, local-config.ts): repos whose PRs only the owner reviews.
 * Pure, and it reads no configuration, so the review queue and the page renderer can import it; callers hand in the globs.
 */

/** `owner/name` globs where `*` stays inside one segment, compared case-insensitively (GitHub names are). */
const toRegExp = (glob: string): RegExp => new RegExp(`^${glob.toLowerCase().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/** True when `repo` (`owner/name`) matches one of `globs`. Fails closed: no repo, or no globs, means a PR is counted and listed with the rest. */
export function isSelfReview(repo: string | undefined, globs: readonly string[]): boolean {
  if (!repo || !globs.length) return false;
  const slug = repo.toLowerCase();
  return globs.some((g) => toRegExp(g).test(slug));
}

/** Splits PRs into the ones other reviewers see (`org`) and the self-review ones, order kept. */
export function splitSelfReview<T extends { repo?: string }>(prs: readonly T[], globs: readonly string[]): { org: T[]; self: T[] } {
  const org: T[] = [];
  const self: T[] = [];
  for (const p of prs) (isSelfReview(p.repo, globs) ? self : org).push(p);
  return { org, self };
}
