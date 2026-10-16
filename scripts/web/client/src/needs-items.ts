/**
 * What waits on the person besides asks, for the needs-you list: their own PRs that are ready to merge, and the review drafted for a
 * teammate's PR that waits for an OK. Pure and DOM-free, and built only from data the page already holds (the Open PRs payload, which is
 * the PR cache, and the draft queue), so listing them costs no GitHub call.
 */
import type { DraftRow, DraftsData } from './drafts-model.ts';
import { readyToMerge } from './pr-ready.ts';
import type { OpenPrRow, OpenPrsData, PrCard } from './types.ts';

export type NeedsKind = 'ready to merge' | 'approve review';

/** One row of the needs-you list that is not an ask. `key` is stable across redraws; `stream` is the one the stream chips filter on. */
export interface NeedsItem {
  key: string;
  kind: NeedsKind;
  stream: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The PR's base branch; a review draft does not carry one. */
  base?: string;
  ticket?: { label: string; url?: string };
  /** A review draft's PR author. */
  author?: string;
  /** A review draft's proposed verdict, in words. */
  verdict?: 'approve' | 'request changes';
  /** A review draft's id, so the row can open that exact card. */
  draftId?: string;
  summary: string;
  ageDays?: number;
}

const OTHER = 'other';
const DAY_MS = 86_400_000;

/**
 * Ready to merge for the needs-you list: the Open PRs tab's rule (not a draft, approved, no open thread, mergeable, checks not failing, a
 * staging PR only after its develop twin merged), tightened to green checks, because this list says "merge it now". A staging PR whose
 * develop twin is still open is held even if `waitsOnDevelop` is missing, so a cache that predates that field cannot let one through.
 */
export function isReadyToMerge(p: OpenPrRow): boolean {
  const developOpen = p.base === 'staging' && p.sides?.develop !== undefined && p.sides.develop.merged !== true;
  // `readyToMerge` lets a self-review repo through on checks alone (drafts, approvals and threads ignored); this list says merge now, so a draft or a PR GitHub has not called mergeable never qualifies.
  return readyToMerge(p) && !p.isDraft && p.mergeable === 'mergeable' && p.ci === 'SUCCESS' && !developOpen;
}

/** The stream of a repo: that of any of its PRs the board knows, else the stream named like the repo, else `other`. */
export function streamOfRepo(repo: string, cards: PrCard[], streams: string[]): string {
  const known = cards.find((c) => c.repo === repo)?.stream;
  if (known) return known;
  const short = repo.split('/')[1] ?? repo;
  return streams.find((s) => s === short) ?? OTHER;
}

const oldestFirst = (a: NeedsItem, b: NeedsItem): number => (b.ageDays ?? -1) - (a.ageDays ?? -1) || a.repo.localeCompare(b.repo) || a.number - b.number;

/** The person's own PRs that are ready to merge, oldest first. A PR missing from `cards` still lists, under `other`. */
export function readyPrItems(data: OpenPrsData | null, cards: PrCard[], streams: string[]): NeedsItem[] {
  if (!data) return [];
  return data.groups.flatMap((g) => g.repos.flatMap((r) => r.prs.filter(isReadyToMerge).map((p): NeedsItem => {
    const approvers = p.approvers ?? [];
    return {
      key: `ready:${r.repo}#${p.number}`, kind: 'ready to merge', stream: cards.find((c) => c.repo === r.repo && c.number === p.number)?.stream ?? streamOfRepo(r.repo, cards, streams),
      repo: r.repo, number: p.number, url: p.url, title: p.title, base: p.base, ...(p.ticket ? { ticket: p.ticket } : {}),
      summary: p.readyOnChecks ? 'Checks passing, no conflict (self-review repo).' : `${approvers.length ? `Approved by ${approvers.join(', ')}` : 'Approved'}, checks passing, no open threads.`,
      ...(p.ageDays !== undefined ? { ageDays: p.ageDays } : {}),
    };
  }))).sort(oldestFirst);
}

/** A drafted review waits for the person while it is pending, or failed (GitHub refused it, so it may be approved again). */
const awaitsOk = (d: DraftRow): boolean => d.source === 'review' && d.severity === 'review' && d.review !== undefined && (d.state === 'pending' || d.state === 'failed');

/** The review drafts waiting for an OK, oldest first: PR link, author when the draft recorded one, the one-line summary and the proposed verdict. */
export function reviewDraftItems(data: DraftsData | null, cards: PrCard[], streams: string[], now: string): NeedsItem[] {
  if (!data) return [];
  const at = Date.parse(now);
  return data.drafts.filter(awaitsOk).map((d): NeedsItem => {
    const made = Date.parse(d.createdAt);
    const verdict = d.review?.event === 'REQUEST_CHANGES' ? 'request changes' : 'approve';
    return {
      key: `review:${d.id}`, draftId: d.id, kind: 'approve review', stream: streamOfRepo(d.repo, cards, streams), repo: d.repo, number: d.pr, url: d.prUrl,
      title: `Review of ${d.repo.split('/')[1] ?? d.repo}#${d.pr}`, verdict, ...(d.author ? { author: d.author } : {}),
      summary: d.context || d.review?.compliment || d.text.split('\n')[0] || 'Drafted review.',
      ...(Number.isFinite(at) && Number.isFinite(made) ? { ageDays: Math.max(0, Math.floor((at - made) / DAY_MS)) } : {}),
    };
  }).sort(oldestFirst);
}

/** Both kinds: reviews first (a teammate is waiting on them), then PRs ready to merge. */
export function needsItems(prs: OpenPrsData | null, drafts: DraftsData | null, cards: PrCard[], streams: string[], now: string): NeedsItem[] {
  return [...reviewDraftItems(drafts, cards, streams, now), ...readyPrItems(prs, cards, streams)];
}

/** The items of one scope: every stream for null, otherwise that stream's. The same cut `scoped` makes for asks. */
export const scopedItems = (items: NeedsItem[], stream: string | null): NeedsItem[] => (stream === null ? items : items.filter((i) => i.stream === stream));

/** A fingerprint of the list: it changes when a row appears, goes, or says something else. Ages are left out, so it does not change at midnight alone. */
export const needsSig = (items: NeedsItem[]): string => items.map((i) => `${i.key}:${i.verdict ?? ''}:${i.summary}`).join('|');
