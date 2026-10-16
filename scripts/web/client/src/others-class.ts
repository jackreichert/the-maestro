/**
 * Which Others' PRs sub-tab a PR belongs to. Pure and DOM-free, so node:test covers it. Each PR lands in exactly one, by precedence:
 * Stale (the gate: no ask for review within the age cutoff), then In review, Threads open, then Not ready, then Ready for approval. A row from an older server (none of the newer fields) is read as clean.
 */
import type { OthersPrRow } from './types.ts';

export type SubTab = 'ready' | 'threads' | 'not-ready' | 'in-review' | 'stale';
/** The sub-tabs in the order shown; the first is the one that opens. */
export const SUBTABS: ReadonlyArray<{ id: SubTab; label: string; empty: string }> = [
  { id: 'ready', label: 'Ready for approval', empty: 'No teammate PR is ready for approval right now.' },
  { id: 'threads', label: 'Threads open', empty: 'No teammate PR has an open review thread.' },
  { id: 'not-ready', label: 'Not ready', empty: 'No teammate PR is blocked for another reason.' },
  { id: 'in-review', label: 'In review', empty: 'You are not reviewing a teammate PR right now.' },
  { id: 'stale', label: 'Stale', empty: 'Nothing has gone stale: every ask is recent.' },
];

export interface Classified { tab: SubTab; reasons: string[] }

/** The words for what keeps a PR from being ready, in a fixed order. */
function blockers(p: OthersPrRow): string[] {
  return [
    ...(p.isDraft ? ['Draft'] : p.notAsked ? ['Not asked yet'] : []),
    ...(p.ci === 'fail' ? ['Checks failing'] : p.ci === 'pending' ? ['Checks pending'] : []),
    ...(p.conflicting ? ['Merge conflict'] : []),
    ...(p.review === 'changes-requested' ? ['Changes requested'] : []),
    ...(p.block === 'release' ? ['Release'] : p.block === 'blocked' ? ['Blocked'] : []),
  ];
}

/**
 * `waitingDraft` is a review draft of yours that is pending a decision on this PR. `awaitingAuthor` (from the server) is a review you posted that the author
 * has not pushed after. Reasons are given for Not ready only; Threads open shows its count instead.
 */
export function classify(p: OthersPrRow, waitingDraft: boolean): Classified {
  if (p.stale === true) return { tab: 'stale', reasons: p.staleWhy ? [p.staleWhy] : [] };
  if (waitingDraft || p.awaitingAuthor === true) return { tab: 'in-review', reasons: [] };
  if (p.unresolved > 0) return { tab: 'threads', reasons: [] };
  const reasons = blockers(p);
  return reasons.length ? { tab: 'not-ready', reasons } : { tab: 'ready', reasons: [] };
}
