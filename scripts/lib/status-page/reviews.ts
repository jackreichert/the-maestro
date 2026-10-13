/** Who approved a PR, from its review history. Pure. */

/** One review as GitHub's `reviews` connection returns it. */
export interface RawReview { state: string; submittedAt?: string; author: { login: string } | null }

export interface ReviewVerdicts { approvers: string[]; changesBy: string[] }

/**
 * Each reviewer's standing verdict: their latest APPROVED, CHANGES_REQUESTED or DISMISSED review (a later comment does not undo
 * either). Only a latest APPROVED counts as an approval, so someone who approved and later requested changes is not an approver,
 * and a dismissed approval is gone. Reviews without an author (a deleted account) are skipped. Names come back sorted.
 */
export function reviewVerdicts(reviews: RawReview[]): ReviewVerdicts {
  const latest = new Map<string, { state: string; at: string; i: number }>();
  reviews.forEach((r, i) => {
    const login = r.author?.login;
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) return;
    const at = r.submittedAt ?? '';
    const prev = latest.get(login);
    if (!prev || at > prev.at || (at === prev.at && i > prev.i)) latest.set(login, { state: r.state, at, i });
  });
  const by = (state: string): string[] => [...latest].filter(([, v]) => v.state === state).map(([login]) => login).sort();
  return { approvers: by('APPROVED'), changesBy: by('CHANGES_REQUESTED') };
}
