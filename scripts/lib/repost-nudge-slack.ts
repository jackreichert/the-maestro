/**
 * Reads when the user last asked for PR reviews in Slack, from the notes slack-watch keeps (`<vault>/Projects/<project>/Slack/*.md`).
 * A line `- 2026-10-15 17:46 ET **Jack**: ... https://github.com/<owner>/<repo>/pull/<n> ...` written by the user and carrying a PR link in one of
 * the given owners counts as an ask. Pure over text, plus one reader that only looks at notes touched recently. The line's clock is Eastern
 * (`ET`, `EST`, `EDT`) or UTC; a line with any other zone is skipped rather than guessed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localParts } from './recurring-time.ts';

const LINE = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (ET|EST|EDT|UTC) \*\*([^*]+)\*\*:(.*)$/;
const PR_LINK = /github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

/** The instant of a wall-clock reading in `zone`: a first guess as UTC, corrected by what the zone shows for it (twice, to settle across a daylight-saving change). */
export function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, zone);
    const [py, pm, pd] = p.day.split('-').map(Number) as [number, number, number];
    guess += want - Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
  }
  return guess;
}

/** The newest ask by `author` in the text (epoch ms), 0 for none. `owners` empty means any owner's PR link counts. */
export function latestAsk(text: string, author: string, owners: readonly string[]): number {
  const want = author.trim().toLowerCase();
  if (!want) return 0;
  let newest = 0;
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m || m[7]!.trim().toLowerCase() !== want) continue;
    const linked = [...m[8]!.matchAll(PR_LINK)].some((l) => !owners.length || owners.some((o) => o.toLowerCase() === l[1]!.toLowerCase()));
    if (!linked) continue;
    const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
    const at = zonedInstant(y, mo, d, h, mi, m[6] === 'UTC' ? 'UTC' : 'America/New_York');
    if (at > newest) newest = at;
  }
  return newest;
}

/** The newest ask across the `.md` notes in `dir` modified within `lookbackMs` of `now`; 0 when the folder is missing or unreadable. */
export function latestAskInDir(dir: string, author: string, owners: readonly string[], now: number, lookbackMs: number): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, f);
      if (now - statSync(path).mtimeMs > lookbackMs) continue;
      newest = Math.max(newest, latestAsk(readFileSync(path, 'utf8'), author, owners));
    }
  } catch { return newest; }
  return newest;
}
