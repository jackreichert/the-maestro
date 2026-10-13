/**
 * The Open PRs tab's data: every open PR the PR cache holds, grouped by repo. A pure reducer over the board state (state.ts), which
 * already carries the cached PRs and how old they are, so this adds no GitHub read and no second cache. Repos in `self_review_repos`
 * (only the user reviews them) form their own group after the repos other people review; inside a group repos run by PR count, then name.
 * Links are data ({ label, url }), built from the page settings; the client never makes one from PR text.
 */
import { keysIn, trackerRef } from '../status-page/render.ts';
import type { PageConfig } from '../status-page/render.ts';
import type { PodiumState, PrCard } from './state.ts';
import type { OpenPrRow, OpenPrSide, OpenPrSides, OpenPrsData, OpenPrsGroup, OpenPrsRepo } from '../../web/client/src/types.ts';

const DAY_MS = 86_400_000;

/**
 * The review verdict. With the review history (latest review per reviewer) an approval is somebody's standing APPROVED and no one's
 * standing CHANGES_REQUESTED; an empty `reviewDecision` is not an approval and not a denial either. Without history (a PR cache from
 * before it was read) GitHub's own decision stands. A decision GitHub does hold, such as REVIEW_REQUIRED (two approvals needed, one given),
 * is never overruled by the history: one approver does not make the PR approved.
 */
export function reviewOf(decision: string | null, approvers?: string[], changesBy?: string[]): OpenPrRow['review'] {
  if (decision === 'CHANGES_REQUESTED' || (changesBy && changesBy.length > 0)) return 'changes-requested';
  if (approvers) return approvers.length > 0 && (decision === null || decision === '' || decision === 'APPROVED') ? 'approved' : 'none';
  return decision === 'APPROVED' ? 'approved' : 'none';
}
const mergeableOf = (m: string): OpenPrRow['mergeable'] => (m === 'MERGEABLE' ? 'mergeable' : m === 'CONFLICTING' ? 'conflicting' : 'unknown');

/** Whole days since `createdAt`, or undefined when the cache predates the field (or holds a date nobody can read). */
function ageDays(createdAt: string | undefined, now: Date): number | undefined {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : undefined;
}

/** The other PRs of the repo that this one is a twin of: those on the same head branch, and the develop PR a staging PR points at. */
function twinsOf(p: PrCard, mine: PrCard[]): number[] {
  const out = new Set(mine.filter((o) => o.number !== p.number && o.head === p.head).map((o) => o.number));
  if (p.twinOf !== undefined) out.add(p.twinOf);
  for (const o of mine) if (o.twinOf === p.number) out.add(o.number);
  return [...out].sort((a, b) => a - b);
}

const sideOf = (p: PrCard): OpenPrSide => ({ number: p.number, url: p.url });
const mergedSideOf = (m: { number: number; url: string }): OpenPrSide => ({ number: m.number, url: m.url, merged: true });

/** The open PR on `base` that this one is paired with, by the same head branch or an explicit twin link. */
function partner(p: PrCard, mine: PrCard[], base: 'develop' | 'staging'): PrCard | undefined {
  return mine.find((o) => o.number !== p.number && o.base === base && (o.head === p.head || o.twinOf === p.number || p.twinOf === o.number));
}

/**
 * Develop and staging of this PR, together. Only a PR whose base is one of those two gets it, so a PR into main
 * is not told it is missing a staging twin. A side that is not open is omitted; the client says none, except a develop PR that has
 * merged while its staging twin is still open: it stays as the develop side, marked `merged`, until the staging PR merges too.
 */
function sidesOf(p: PrCard, mine: PrCard[]): OpenPrSides | undefined {
  if (p.base !== 'develop' && p.base !== 'staging') return undefined;
  const develop = p.base === 'develop' ? p : partner(p, mine, 'develop');
  const staging = p.base === 'staging' ? p : partner(p, mine, 'staging');
  const merged = !develop && staging?.developMerged ? mergedSideOf(staging.developMerged) : undefined;
  return { ...(develop ? { develop: sideOf(develop) } : merged ? { develop: merged } : {}), ...(staging ? { staging: sideOf(staging) } : {}) };
}

function row(p: PrCard, mine: PrCard[], page: PageConfig, now: Date): OpenPrRow {
  const key = keysIn(page, `${p.title} ${p.head}`)[0];
  const age = ageDays(p.createdAt, now);
  const sides = sidesOf(p, mine);
  return {
    number: p.number, title: p.title, url: p.url, base: p.base, head: p.head, isDraft: p.isDraft, review: reviewOf(p.review, p.approvers, p.changesBy),
    unresolved: p.unresolved, mergeable: mergeableOf(p.mergeable), twins: twinsOf(p, mine), ...(sides ? { sides } : {}),
    ...(p.ci ? { ci: p.ci } : {}), ...(p.approvers ? { approvers: p.approvers } : {}), ...(p.stackedOn !== undefined ? { stackedOn: p.stackedOn } : {}), ...(p.waitsOnDevelop ? { waitsOnDevelop: p.waitsOnDevelop } : {}),
    ...(age !== undefined ? { ageDays: age } : {}),
    ...(key ? { ticket: (({ label, url }) => (url === undefined ? { label } : { label, url }))(trackerRef(page, key)) } : {}),
  };
}

/** A repo's rows, twins side by side: a PR and its twins sort by the lowest number among them, then by number. */
function repoRows(prs: PrCard[], page: PageConfig, now: Date): OpenPrRow[] {
  const rows = prs.map((p) => row(p, prs, page, now));
  const anchor = (r: OpenPrRow): number => Math.min(r.number, ...r.twins);
  return rows.sort((a, b) => anchor(a) - anchor(b) || a.number - b.number);
}

function repos(prs: PrCard[], page: PageConfig, now: Date): OpenPrsRepo[] {
  const by = new Map<string, PrCard[]>();
  for (const p of prs) by.set(p.repo, [...(by.get(p.repo) ?? []), p]);
  return [...by].map(([repo, list]): OpenPrsRepo => ({ repo, count: list.length, prs: repoRows(list, page, now) }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

/** The tab's payload: the groups (a group with no PRs is left out), the total and the PR data's age and failure. */
export function buildOpenPrs(state: PodiumState, page: PageConfig, now: Date): OpenPrsData {
  const team = state.prs.filter((p) => !p.selfReview);
  const self = state.prs.filter((p) => p.selfReview);
  const all: OpenPrsGroup[] = [
    { id: 'team', label: 'Team repos', count: team.length, repos: repos(team, page, now) },
    { id: 'self-review', label: 'Self-review repos', count: self.length, repos: repos(self, page, now) },
  ];
  return { generatedAt: now.toISOString(), prData: state.prData, total: state.prs.length, groups: all.filter((g) => g.count > 0) };
}
