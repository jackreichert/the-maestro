/**
 * Turns an actionable digest into queued fix items. Rules only: no model call, no GitHub, no live PR state.
 * Ambiguous lines (bot threads, LGTM, thanks, ordinary comments) are left for a later triage slice.
 *
 * Queued: CONFLICT, REVIEW whose state is CHANGES_REQUESTED, and a CHECKS-FAILING line already in the text.
 * The caller passes the owner allowlist and any keys already queued. An empty allowlist queues nothing.
 */
import { fold, isOpen, parseLedger } from './ledger-core.ts';
import { isSelfReview } from './self-review.ts';

export type FixKind = 'CONFLICT' | 'CHANGES_REQUESTED' | 'CHECKS-FAILING';

/** One fix the supervisor should queue. `key` is stable across passes; `text` is what `journal.ts queue` receives. */
export interface DigestFix {
  key: string;
  text: string;
  kind: FixKind;
  repo: string;
  number: number;
  url: string;
}

export interface QueueDigestOptions {
  /** GitHub owners whose PRs may be queued. Empty queues nothing. */
  owners: readonly string[];
  /** `self_review_repos` globs (`owner/name`, a bare owner already expanded to `owner/*`). */
  excludeRepos?: readonly string[];
  /** Keys already on an open ledger item. A second pass passes the same set and queues nothing new. */
  alreadyQueued?: ReadonlySet<string>;
  queue: (item: DigestFix) => void;
  log?: (line: string) => void;
}

/** Logged when the allowlist is empty, so an unset config does not queue every owner. */
export const NO_OWNER_LOG = 'digest queue skipped: no owner allowlist (set copilot_orgs or gh_org)';

const DIGEST_LINE = /^(?:ACTION|info)\s+\S+\s+\(([^)]+)\):\s+(.*)$/;
const PR_KEY = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;
const URL = /https?:\/\/\S+/;
const FIX_TEXT = /^fix\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+)\s+(CONFLICT|CHANGES_REQUESTED|CHECKS-FAILING)\s+(\S+)/;
const REVIEW = /^REVIEW\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+)\s+by\s+\S+\s+\(([^)]+)\):\s+(https?:\/\/\S+)/;
const CHECKS = /^CHECKS-FAILING\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+)\b(.*)$/;
const CONFLICT = /^CONFLICT\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+)\b/;

/** `copilot_orgs` when it has entries, else `gh_org`, else nothing. Callers pass the config values in. */
export function digestQueueOwners(copilotOrgs: readonly string[], ghOrg: string): string[] {
  const listed = copilotOrgs.map((o) => o.trim()).filter(Boolean);
  if (listed.length) return listed;
  const org = ghOrg.trim();
  return org ? [org] : [];
}

/** The journal line for a fix. The three tokens are the stable key. */
export function fixText(repo: string, number: number, kind: FixKind, id: string): string {
  return `fix ${repo}#${number} ${kind} ${id}`;
}

/** `owner/repo#number|kind|url-or-id`. */
export function fixKey(repo: string, number: number, kind: FixKind, id: string): string {
  return `${repo}#${number}|${kind}|${id}`;
}

/** The key embedded in a queued fix line, or null when the text is not one of ours. */
export function keyFromFixText(text: string): string | null {
  const m = text.match(FIX_TEXT);
  return m ? `${m[1]}|${m[2]}|${m[3]}` : null;
}

/**
 * Keys carried by open ledger items (queued or already started). A closed item does not block a later event.
 * Malformed lines are skipped. The text is the ledger file, not a live board.
 */
export function queuedFixKeys(ledgerText: string): Set<string> {
  const { items } = fold(parseLedger(ledgerText, () => {}), null);
  const keys = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'wip' || !isOpen(item)) continue;
    const key = keyFromFixText(item.text ?? '');
    if (key) keys.add(key);
  }
  return keys;
}

const cleanUrl = (url: string): string => url.replace(/[),.;]+$/, '');

function prOf(token: string): { repo: string; number: number } | null {
  const m = token.match(PR_KEY);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

interface Candidate { repo: string; number: number; kind: FixKind; id: string }

/** The always-actionable fact in one pr-watch summary, or null. The `[self-review]` prefix is reported separately. */
function candidate(summary: string): { selfReview: boolean; item: Candidate | null } {
  const selfReview = summary.startsWith('[self-review] ');
  const body = selfReview ? summary.slice('[self-review] '.length) : summary;
  const review = body.match(REVIEW);
  if (review) {
    if (review[2] !== 'CHANGES_REQUESTED') return { selfReview, item: null };
    const pr = prOf(review[1]);
    return pr ? { selfReview, item: { ...pr, kind: 'CHANGES_REQUESTED', id: cleanUrl(review[3]) } } : { selfReview, item: null };
  }
  if (CONFLICT.test(body)) {
    const key = body.match(CONFLICT)?.[1] ?? '';
    const url = body.match(URL);
    const pr = prOf(key);
    if (!pr || !url) return { selfReview, item: null };
    return { selfReview, item: { ...pr, kind: 'CONFLICT', id: cleanUrl(url[0]) } };
  }
  const checks = body.match(CHECKS);
  if (checks) {
    const pr = prOf(checks[1]);
    if (!pr) return { selfReview, item: null };
    const url = checks[2].match(URL);
    const token = checks[2].trim().split(/\s+/).filter(Boolean)[0];
    return { selfReview, item: { ...pr, kind: 'CHECKS-FAILING', id: url ? cleanUrl(url[0]) : (token || `${pr.repo}#${pr.number}`) } };
  }
  return { selfReview, item: null };
}

function allowed(owner: string, owners: readonly string[]): boolean {
  const want = owner.toLowerCase();
  return owners.some((o) => o.toLowerCase() === want);
}

/**
 * Queues the always-actionable pr-watch lines in `digest`. Returns the items queued this call.
 * A repeated key, in `alreadyQueued` or earlier in this digest, is skipped. The callback is not a model.
 */
export function queueActionableDigest(digest: string, opts: QueueDigestOptions): DigestFix[] {
  const owners = opts.owners.map((o) => o.trim()).filter(Boolean);
  if (!owners.length) {
    opts.log?.(NO_OWNER_LOG);
    return [];
  }
  const exclude = opts.excludeRepos ?? [];
  const seen = new Set(opts.alreadyQueued ?? []);
  const queued: DigestFix[] = [];
  for (const raw of digest.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const wrapped = line.match(DIGEST_LINE);
    if (!wrapped || wrapped[1] !== 'pr-watch') continue;
    const summary = wrapped[2].split(' | report:')[0].trim();
    const { selfReview, item } = candidate(summary);
    if (!item) continue;
    if (selfReview || isSelfReview(item.repo, exclude)) continue;
    const owner = item.repo.split('/')[0] ?? '';
    if (!allowed(owner, owners)) continue;
    const key = fixKey(item.repo, item.number, item.kind, item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const fix: DigestFix = { key, text: fixText(item.repo, item.number, item.kind, item.id), kind: item.kind, repo: item.repo, number: item.number, url: item.id };
    opts.queue(fix);
    queued.push(fix);
  }
  return queued;
}
