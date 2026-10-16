/**
 * Whether a teammate PR is settled: it no longer needs the person's review, so it leaves the Others' PRs tab and the review drafts queued for it are rejected.
 * One classifier, pure over normalised facts, used by the tab's cache (lib/teammate/others.ts, from the GraphQL search) and by the draft settler (lib/drafts/settle.ts, from `gh pr view`).
 *
 * Settled means one of:
 *   - merged or closed;
 *   - approved: GitHub's reviewDecision is APPROVED, or someone's latest decisive review is an APPROVED one made at or after the live head commit;
 *   - picked up: a person other than the author, a bot and you reviewed it after it was opened (APPROVED, CHANGES_REQUESTED, or COMMENTED with a body). That covers
 *     a reviewer who was requested and has already reviewed.
 *
 * Two things keep a PR on the tab. (1) You were explicitly requested and have not reviewed: someone else's comment does not take it from you. This holds against
 * "picked up" only; an approved, merged or closed PR leaves even when you were asked. (2) The author pushed after the picking-up review and a reviewer is requested again:
 * the push made that review old and the re-request asks for another, so the card comes back. An approval before a later push is not "approved" either (the head moved on).
 */

export interface SettledReview { login: string; bot: boolean; state: string; at: string; body: string }
export interface SettledFacts {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** GitHub's reviewDecision; null when none. */
  decision: string | null;
  author: string; self: string; createdAt: string;
  /** When the head commit was made; absent means unknown (an approval is then read as being at the head). */
  headAt?: string;
  /** Logins of users asked to review right now. */
  requested: readonly string[];
  reviews: readonly SettledReview[];
}
export type SettledWhy = 'merged' | 'closed' | 'approved' | 'picked-up';
export interface Settled { why: SettledWhy; text: string }

const lower = (s: string): string => s.toLowerCase();
const ms = (s: string | undefined): number => Date.parse(s ?? '');
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Each person's newest submitted review (pending ones are not submitted), oldest first within the result. */
const submitted = (rs: readonly SettledReview[]): SettledReview[] => rs.filter((r) => r.state !== 'PENDING' && Number.isFinite(ms(r.at))).sort((a, b) => ms(a.at) - ms(b.at));

/** True when a review is something a person who owns the PR would act on: a verdict, or a comment with substance. */
const substantive = (r: SettledReview): boolean => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body.trim() !== '');

export function settledReason(f: SettledFacts): Settled | null {
  if (f.state === 'MERGED') return { why: 'merged', text: 'the PR was merged' };
  if (f.state === 'CLOSED') return { why: 'closed', text: 'the PR was closed' };
  const reviews = submitted(f.reviews);
  const head = ms(f.headAt);
  if (f.decision === 'APPROVED') return { why: 'approved', text: 'the PR is approved' };
  const latest = new Map<string, SettledReview>();
  for (const r of reviews) if (!r.bot && lower(r.login) !== lower(f.author) && DECISIVE.has(r.state)) latest.set(lower(r.login), r);
  const approver = [...latest.values()].find((r) => r.state === 'APPROVED' && (!Number.isFinite(head) || ms(r.at) >= head));
  if (approver) return { why: 'approved', text: `the PR was approved by ${approver.login} at its current head` };

  const asked = f.self !== '' && f.requested.some((l) => lower(l) === lower(f.self));
  const mineDone = reviews.some((r) => lower(r.login) === lower(f.self) && f.self !== '');
  if (asked && !mineDone) return null;
  const others = reviews.filter((r) => !r.bot && lower(r.login) !== lower(f.author) && lower(r.login) !== lower(f.self) && substantive(r) && ms(r.at) > ms(f.createdAt));
  const last = others[others.length - 1];
  if (!last) return null;
  if (Number.isFinite(head) && head > ms(last.at) && f.requested.length > 0) return null;
  return { why: 'picked-up', text: `${last.login} already reviewed it (${last.state.toLowerCase().replace('_', ' ')})` };
}
