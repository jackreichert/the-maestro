/**
 * Which stream an open PR belongs to. Streams span several repos, so the repo alone says little; the work item does.
 * Order: (a) the ledger's own evidence, (b) `stream-overrides.json`, (c) the repo map, else `other`.
 *   (a) votes: board items that name a tracker key found in the PR's title or branch (directly, or through
 *       ticket-map.json's ask ids), and board items whose refs name the PR itself (`gh:pr:<repo>#N`, `<repo>#N`).
 * Pure; generate.ts supplies the board and the files. No org, repo or stream name is built in.
 */
import type { Item } from './render.ts';

export interface StreamEvidence {
  /** Every item on the board (in flight, blocked, awaiting, done). */
  items: Item[];
  /** ticket id to the ask ids it covers (ticket-map.json). */
  ticketMap: Record<string, string[]>;
  /** `repo#N` (or `owner/repo#N`) to stream (stream-overrides.json). */
  overrides: Record<string, string>;
  /** Short repo name to stream (status_repo_streams). */
  repoStreams: Record<string, string>;
  /** tracker_key_pattern, as a regular expression source. */
  keyPattern: string;
}

export interface PrIdentity { number: number; title: string; headRefName: string; short: string; nameWithOwner: string }

const OTHER = 'other';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tracker keys in a PR's title and branch, upper-cased (CVE ids are not tickets). */
export function prKeys(pr: PrIdentity, keyPattern: string): string[] {
  const text = `${pr.title} ${pr.headRefName}`.replace(/\bCVE-\d+/g, '');
  return [...new Set((text.match(new RegExp(keyPattern, 'g')) ?? []).map((k) => k.toUpperCase()))];
}

/** The most-voted real stream; the earliest-counted stream wins a tie. Undefined when nobody voted. */
function topStream(votes: (string | undefined)[]): string | undefined {
  const tally = new Map<string, number>();
  for (const v of votes) if (v && v !== 'none' && v !== OTHER) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [stream, n] of tally) if (best === undefined || n > (tally.get(best) ?? 0)) best = stream;
  return best;
}

/** Streams of the board items that evidence this PR. */
function ledgerVotes(pr: PrIdentity, ev: StreamEvidence): (string | undefined)[] {
  const byId = new Map(ev.items.map((i) => [i.id, i]));
  const refNames = [pr.short, pr.nameWithOwner].flatMap((r) => [`${r}#${pr.number}`, `gh:pr:${r}#${pr.number}`]);
  const votes: (string | undefined)[] = ev.items.filter((i) => (i.refs ?? []).some((r) => refNames.includes(r))).map((i) => i.stream);
  for (const key of prKeys(pr, ev.keyPattern)) {
    const word = new RegExp(`(?<![A-Za-z0-9])${escapeRe(key)}(?!\\d)`, 'i');
    votes.push(...ev.items.filter((i) => word.test(`${i.text} ${(i.refs ?? []).join(' ')}`)).map((i) => i.stream));
    const mapped = Object.entries(ev.ticketMap).filter(([t]) => t.toUpperCase() === key).flatMap(([, ids]) => ids);
    votes.push(...mapped.map((id) => byId.get(id)?.stream));
  }
  return votes;
}

/** The stream of one open PR. */
export function prStream(pr: PrIdentity, ev: StreamEvidence): string {
  return topStream(ledgerVotes(pr, ev))
    ?? ev.overrides[`${pr.short}#${pr.number}`]
    ?? ev.overrides[`${pr.nameWithOwner}#${pr.number}`]
    ?? ev.repoStreams[pr.short]
    ?? OTHER;
}
