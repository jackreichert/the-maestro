/**
 * What the slack-watch engineering notes (`engineering*.md`) say about a PR: when its thread last had a post or reply, and whether it has a reply.
 * A local file read only, never a network call; each note is parsed once and re-read when it changes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PR_URL = /https:\/\/github\.com\/[^\s)>\]|]+?\/pull\/\d+/gi;
const POST = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ET (↳ )?(.*)$/;
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });

/** The instant of a wall-clock time in US Eastern, as milliseconds. The offset is read for that date, so daylight saving is honoured. */
export function etMs(y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number): number => {
    const name = ET.formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT-05:00';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : -300;
  };
  // The offset is read at the instant itself, so a time just after a clock change gets the new offset.
  const off = offsetAt(wall - offsetAt(wall) * 60_000);
  const guess = wall;
  return guess - off * 60_000;
}

/** What the Slack notes say about one PR: when its thread last had a post or reply, and whether that thread has a reply. */
export interface SlackActivity { at: number; replied: boolean }
interface Thread { urls: Set<string>; at: number; replied: boolean }
const slackCache = new Map<string, { mtimeMs: number; size: number; threads: Thread[] }>();

/** Threads in one note: a post and the replies (`↳`) under it. Every PR link in any line belongs to the whole thread, so a reply re-ups the PR. */
function parseThreads(text: string): Thread[] {
  const out: Thread[] = [];
  let cur: Thread | null = null;
  for (const line of text.split('\n')) {
    const m = POST.exec(line);
    if (!m) continue;
    const at = etMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    if (!m[6] || !cur) { cur = { urls: new Set(), at, replied: false }; out.push(cur); }
    if (m[6]) cur.replied = true;
    cur.at = Math.max(cur.at, at);
    for (const u of m[7]?.match(PR_URL) ?? []) cur.urls.add(u.toLowerCase());
  }
  return out.filter((t) => t.urls.size > 0);
}

/** PR links in the slack-watch engineering notes (`engineering*.md`), each with its newest thread activity. A local read only, re-read when a file changes; a missing folder is nothing. */
export function slackActivity(dir: string | undefined): Map<string, SlackActivity> {
  const out = new Map<string, SlackActivity>();
  if (!dir) return out;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^engineering.*\.md$/i.test(f)); } catch { return out; }
  for (const f of files) {
    const file = join(dir, f);
    try {
      const st = statSync(file);
      let hit = slackCache.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        hit = { mtimeMs: st.mtimeMs, size: st.size, threads: parseThreads(readFileSync(file, 'utf8')) };
        slackCache.set(file, hit);
      }
      for (const t of hit.threads) for (const u of t.urls) {
        const prev = out.get(u);
        out.set(u, { at: Math.max(prev?.at ?? 0, t.at), replied: t.at >= (prev?.at ?? 0) ? t.replied : (prev?.replied ?? false) });
      }
    } catch { /* an unreadable note adds no links */ }
  }
  return out;
}
