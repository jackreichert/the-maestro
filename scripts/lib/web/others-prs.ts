/**
 * The Others' PRs tab's data: every open teammate PR the cache holds (`.now-others-prs.json`, written by the status-page rebuild), newest activity first.
 * Reads the cache only, so a page load never reaches GitHub. Own PRs and self-review repos are left out here as well as at fetch time,
 * so a changed `self_review_repos` takes effect before the next rebuild. The review-draft status is joined by the page from the draft queue, which changes on its own.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readOthersCache } from '../teammate/others.ts';
import type { Guard } from '../teammate/wait.ts';
import type { OtherPr } from '../teammate/others.ts';
import { isGuard, NO_GUARD } from '../teammate/wait.ts';
import { isSelfReview } from '../self-review.ts';
import { PR_STALE_MS } from './state.ts';
import type { OthersPrRow, OthersPrsData } from '../../web/client/src/types.ts';

const DAY_MS = 86_400_000;

export interface OthersScopeOptions { statusDir: string; owners: readonly string[]; selfRepos: readonly string[]; self: string; guard?: Guard;
  /** A PR whose latest ask (Slack activity, or its own opened time when never posted) is older than this many days is marked stale, unless you are asked for review or @-mentioned. Absent means no cutoff. */
  maxAgeDays?: number;
  /** The folder of the slack-watch engineering notes (`<vault_root>/Projects/<container>/Slack`); absent means no Slack ask is known. */
  slackDir?: string;
  /** Names that count as @-mentioning you in Slack (`others_prs_mention_names`). */
  mentionNames?: readonly string[] }

const reviewOf = (decision: string | null): OthersPrRow['review'] => (decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes-requested' : 'review-required');

const PR_URL = /https:\/\/github\.com\/[^\s)>\]|]+?\/pull\/\d+/gi;
const POST = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ET (↳ )?(.*)$/;
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });

/** The instant of a wall-clock time in US Eastern, as milliseconds. The offset is read for that date, so daylight saving is honoured. */
export function etMs(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const name = ET.formatToParts(new Date(guess)).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  const off = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : -300;
  return guess - off * 60_000;
}

/** What the Slack notes say about one PR: when its thread last had a post or reply, and whether the thread @-mentions one of the configured names. */
export interface SlackActivity { at: number; mentioned: boolean; replied: boolean }
interface Thread { urls: Set<string>; at: number; mentioned: boolean; replied: boolean }
const slackCache = new Map<string, { mtimeMs: number; size: number; names: string; threads: Thread[] }>();

/** Threads in one note: a post and the replies (`↳`) under it. Every PR link in any line belongs to the whole thread, so a reply re-ups the PR. */
function parseThreads(text: string, mention: RegExp | null): Thread[] {
  const out: Thread[] = [];
  let cur: Thread | null = null;
  for (const line of text.split('\n')) {
    const m = POST.exec(line);
    if (!m) continue;
    const at = etMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    if (!m[6] || !cur) { cur = { urls: new Set(), at, mentioned: false, replied: false }; out.push(cur); }
    if (m[6]) cur.replied = true;
    cur.at = Math.max(cur.at, at);
    for (const u of m[7]?.match(PR_URL) ?? []) cur.urls.add(u.toLowerCase());
    if (mention && mention.test(m[7] ?? '')) cur.mentioned = true;
  }
  return out.filter((t) => t.urls.size > 0);
}

/** PR links in the slack-watch engineering notes (`engineering*.md`), each with its newest thread activity. A local read only, re-read when a file changes; a missing folder is nothing. */
export function slackActivity(dir: string | undefined, names: readonly string[] = []): Map<string, SlackActivity> {
  const out = new Map<string, SlackActivity>();
  if (!dir) return out;
  const key = names.join('|');
  const mention = names.length ? new RegExp(`@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w])`, 'i') : null;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^engineering.*\.md$/i.test(f)); } catch { return out; }
  for (const f of files) {
    const file = join(dir, f);
    try {
      const st = statSync(file);
      let hit = slackCache.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size || hit.names !== key) {
        hit = { mtimeMs: st.mtimeMs, size: st.size, names: key, threads: parseThreads(readFileSync(file, 'utf8'), mention) };
        slackCache.set(file, hit);
      }
      for (const t of hit.threads) for (const u of t.urls) {
        const prev = out.get(u);
        out.set(u, { at: Math.max(prev?.at ?? 0, t.at), mentioned: (prev?.mentioned ?? false) || t.mentioned, replied: t.at >= (prev?.at ?? 0) ? t.replied : (prev?.replied ?? false) });
      }
    } catch { /* an unreadable note adds no links */ }
  }
  return out;
}

/** Open, nobody asked, nobody looked, and not posted in Slack: pushed but not yet asking for review. Drafts are reported as drafts instead. */
const notAsked = (p: OtherPr, youAsked: boolean, slack: ReadonlyMap<string, SlackActivity>): boolean =>
  p.isDraft === false && !youAsked && p.requested.length === 0 && p.decision === null && p.unresolved === 0 && (p.reviewCount ?? 1) === 0 && !p.yourReview && !slack.has(p.url.toLowerCase());

const CI: Record<string, NonNullable<OthersPrRow['ci']>> = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'pending', EXPECTED: 'pending' };
const BLOCK_LABEL = /block|do not merge|don'?t merge|\bwip\b|\bhold\b/i;

/** A review you posted that the author has not pushed after (a commit at or before the review). An approval is not waiting on anything. */
const awaiting = (p: OtherPr): boolean => {
  const r = p.yourReview;
  if (!r || (r.state !== 'COMMENTED' && r.state !== 'CHANGES_REQUESTED') || !p.headAt) return false;
  return Date.parse(p.headAt) <= Date.parse(r.at);
};

function row(p: OtherPr, self: string, guard: Guard, now: Date, slack: ReadonlyMap<string, SlackActivity>, cutoff: number | null): OthersPrRow {
  const opened = Date.parse(p.createdAt);
  const youAsked = self !== '' && p.requested.some((r) => r.toLowerCase() === self.toLowerCase());
  return {
    repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, ...(p.authorName ? { authorName: p.authorName } : {}), base: p.base, updatedAt: p.updatedAt,
    ...(Number.isFinite(opened) ? { ageDays: Math.max(0, Math.floor((now.getTime() - opened) / DAY_MS)) } : {}),
    youAsked, ...(isGuard(p.repo, p.author, guard) && !youAsked ? { handsOff: true } : {}),
    review: reviewOf(p.decision), unresolved: p.unresolved, copilotThreads: p.copilotThreads,
    ...(typeof p.isDraft === 'boolean' ? { isDraft: p.isDraft } : {}),
    ci: (p.ci && CI[p.ci]) || 'none',
    ...(p.mergeable === 'CONFLICTING' ? { conflicting: true } : {}),
    ...(p.head.startsWith('release/') ? { block: 'release' as const } : (p.labels ?? []).some((l) => BLOCK_LABEL.test(l)) ? { block: 'blocked' as const } : {}),
    ...(awaiting(p) ? { awaitingAuthor: true } : {}),
    ...(notAsked(p, youAsked, slack) ? { notAsked: true } : {}),
    ...ask(p, youAsked, slack, now, cutoff),
  };
}

/**
 * The latest ask for review: the newest Slack post or reply carrying the PR link, or, when it was never posted, the PR's own opening time (GitHub gives no ready or
 * re-request time to this tab). Past the cutoff the PR is stale, unless you are asked for review or @-mentioned: a direct ask never goes stale.
 */
function ask(p: OtherPr, youAsked: boolean, slack: ReadonlyMap<string, SlackActivity>, now: Date, cutoff: number | null): Pick<OthersPrRow, 'askedAt' | 'stale' | 'staleWhy'> {
  const s = slack.get(p.url.toLowerCase());
  const at = s ? s.at : Date.parse(p.createdAt);
  if (!Number.isFinite(at)) return {};
  const days = Math.round((now.getTime() - at) / DAY_MS);
  const stale = cutoff !== null && at < cutoff && !youAsked && !s?.mentioned;
  const why = s ? (s.replied ? `last Slack reply ${days}d ago` : `Slack post ${days}d, no reply`) : `never posted, opened ${days}d ago`;
  return { askedAt: new Date(at).toISOString(), ...(stale ? { stale: true, staleWhy: why } : {}) };
}

export function buildOthersPrs(o: OthersScopeOptions, now: Date): OthersPrsData {
  const cache = readOthersCache(o.statusDir);
  const owners = new Set(o.owners.map((x) => x.toLowerCase()));
  const self = o.self.toLowerCase();
  const kept = (cache?.prs ?? [])
    .filter((p) => p.author.toLowerCase() !== self && owners.has((p.repo.split('/')[0] ?? '').toLowerCase()) && !isSelfReview(p.repo, o.selfRepos))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const slack = slackActivity(o.slackDir, o.mentionNames);
  const cutoff = o.maxAgeDays === undefined ? null : now.getTime() - o.maxAgeDays * DAY_MS;
  const fetchedAt = cache?.fetchedAt ?? null;
  const stale = !fetchedAt || now.getTime() - fetchedAt.getTime() > PR_STALE_MS;
  return {
    generatedAt: now.toISOString(),
    prData: { fetchedAt: fetchedAt ? fetchedAt.toISOString() : null, stale, ...(cache?.failure ? { failure: cache.failure } : {}) },
    total: kept.length, prs: kept.map((p) => row(p, o.self, o.guard ?? NO_GUARD, now, slack, cutoff)),
  };
}
