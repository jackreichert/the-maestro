/**
 * The Slack route onto the Others' PRs list: a PR link posted with review-ask wording in a watched channel, and a teammate's claim of it in the thread.
 * "Watched channel" means a slack-watch note, `engineering*.md` in the container project's `Slack` folder (the notes lib/web/slack-activity.ts already reads);
 * this is a local file read, never a Slack call. Lines look like `- 2026-10-13 09:00 ET [↳ ]**Name**: text`.
 *
 * Detection is deterministic wording, not judgement: `ASK` words next to a PR link make an ask, `CLAIM` words in a reply under an ask make a claim.
 * Only the PR key, the channel (the note's name), the poster's display name and the time leave this file. The message text is read here and never kept.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etMs } from '../web/slack-activity.ts';
import { listKey } from './others-list.ts';

const LINE = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ET (↳ )?(.*)$/;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,8})\b/gi;
const AUTHOR = /^\*\*([^*]{1,80})\*\*/;

/** Wording that asks for a review. A message that says it was already done is not an ask. */
const ASK = /\b(review|reviews|reviewing|ptal|take a look|look at|looking for (?:a )?(?:review|eyes)|eyes on|second pair of eyes|approve|approval|feedback|sanity[- ]check|lgtm\?|can (?:someone|anyone|somebody)|could (?:someone|anyone|somebody)|need(?:s)? (?:a )?(?:review|approval))\b/i;
const NOT_AN_ASK = /\b(merged|already (?:reviewed|approved)|reviewed by|thanks? for (?:the )?review(?:ing)?|thank you for (?:the )?review(?:ing)?|approved by)\b/i;
/** Wording that takes a review on: "I'll take it", "on it", "looking now". */
const CLAIM = /\b(i'?ll (?:take|review|look|get|grab|do)|i will (?:take|review|look)|i can (?:take|review|look)|i'?ve got (?:it|this)|i got (?:it|this)|got it|taking (?:it|this|a look)|on it|looking (?:now|at it|at this)|i'?m (?:on|looking|reviewing)|reviewing (?:now|it|this))\b/i;

export interface SlackAsk { key: string; at: number; channel: string; author?: string }
export interface SlackClaim { key: string; at: number }
export interface SlackScan { asks: SlackAsk[]; claims: SlackClaim[] }
export interface SlackScanOptions {
  /** GitHub owners whose PRs count (`review_queue_orgs`); a link to any other owner is ignored. */
  owners: readonly string[];
  /** Your display names in Slack: a reply by you is never a claim by someone else. */
  selfNames?: readonly string[];
}

const keysIn = (text: string, owners: ReadonlySet<string>): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(PR_URL)) if (owners.has((m[1] ?? '').toLowerCase())) out.add(listKey(`${m[1]}/${m[2]}#${m[3]}`));
  return [...out];
};

/** Asks and claims in one note's text. `channel` is the note's name; the same PR asked twice keeps its newest ask. With no `selfNames` no claim is read (a reply by you could not be told from a teammate's, and a wrong claim drops a PR you meant to review); asks are unaffected. */
export function scanNote(text: string, channel: string, o: SlackScanOptions): SlackScan {
  const owners = new Set(o.owners.map((x) => x.toLowerCase()));
  const me = new Set((o.selfNames ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  const asks = new Map<string, SlackAsk>();
  const claims: SlackClaim[] = [];
  let thread: { keys: Set<string>; poster?: string } | null = null;
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const at = etMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    const isReply = Boolean(m[6]);
    const body = m[7] ?? '';
    const author = AUTHOR.exec(body)?.[1]?.trim();
    if (!isReply || !thread) thread = { keys: new Set(), ...(author ? { poster: author } : {}) };
    const keys = keysIn(body, owners);
    if (keys.length && ASK.test(body) && !NOT_AN_ASK.test(body)) {
      for (const key of keys) {
        thread.keys.add(key);
        const prev = asks.get(key);
        if (!prev || at > prev.at) asks.set(key, { key, at, channel, ...(author ? { author } : {}) });
      }
    } else if (me.size && isReply && thread.keys.size && CLAIM.test(body) && !NOT_AN_ASK.test(body)) {
      const who = author?.toLowerCase();
      if (who && (me.has(who) || who === thread.poster?.toLowerCase())) continue;
      for (const key of thread.keys) claims.push({ key, at });
    }
  }
  return { asks: [...asks.values()], claims };
}

/** Asks and claims across every `engineering*.md` note in `dir`; a missing folder or an unreadable note adds nothing. */
export function scanSlack(dir: string | undefined, o: SlackScanOptions): SlackScan {
  const out: SlackScan = { asks: [], claims: [] };
  if (!dir) return out;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^engineering.*\.md$/i.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const s = scanNote(readFileSync(join(dir, f), 'utf8'), f.replace(/\.md$/i, ''), o);
      out.asks.push(...s.asks);
      out.claims.push(...s.claims);
    } catch { /* an unreadable note adds nothing */ }
  }
  return out;
}
