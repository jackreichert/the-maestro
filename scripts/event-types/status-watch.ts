/**
 * status-watch: wakes the orchestrator when the user edits the status page by hand. Target is the status directory
 * (the one holding The-Podium.md); see scripts/lib/status-page/inline.ts for what counts as an edit: an `> answer:` line under
 * an ask, a ticked `- [x]` box on an ask, or a changed priorities list.
 *
 * Each check compares The-Podium.md with the baseline beside it (`.now-seen.md`) and reports only what is new, one actionable
 * event per ask (answer and tick together) and one for the priorities, then adopts The-Podium.md as the new baseline. A page the
 * generator wrote itself is recognised by its hash (`.now-seen.json`) and reported as nothing, so regenerating never fires.
 * The baseline moves in `check`, before the loop records the events: a crash in that instant loses them, which the
 * answer still on the page (until the next regeneration) makes visible to a person but not to the loop.
 * The digest cuts a summary at 300 characters, so the decision comes before the answer; a summary ending in `...` has the
 * full text in `.now-seen.md` (the baseline just adopted), under the same ask id.
 * State { sha, fresh } is the page hash and the summaries to report this tick; `fresh` is empty on every quiet check.
 * `add` refuses a target that is not an existing directory.
 */
import { existsSync, statSync } from 'node:fs';
import { extractFields, unprocessed } from '../lib/status-page/inline.ts';
import { PODIUM_FILE, readPodium, readSeenMeta, readSeenPage, sha, writeSeenMeta, writeSeenPage } from '../lib/status-page/seen.ts';
import type { Unprocessed } from '../lib/status-page/inline.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface StatusWatchState { sha: string; fresh: string[] }

// Scheduling: a local file read every minute; no idle back-off, so an answer is noticed within about a minute.
export const interval = 60;
export const network = false;
export const backoff = false;
export const singleton = true;
// The user's own edits are not worth a phone buzz.
export const notifies = 'never' as const;

const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`status-watch target must be the status directory (the folder holding ${PODIUM_FILE}), got "${target}"`);
}

/** Ask id to the last cell of its table row (the decision needed from the user), to say what an answer was about. */
function decisions(page: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of page.split('\n')) {
    const m = line.match(/^\| `([a-z0-9]{4,6})` \|(.*)\|\s*$/);
    const cells = (m?.[2] ?? '').split(/(?<!\\)\|/);
    if (m) out.set(m[1] as string, (cells[cells.length - 1] ?? '').replace(/\\\|/g, '|').trim());
  }
  return out;
}

/** One summary per ask that was answered or ticked, then one for the priorities. */
export function describe(u: Unprocessed, page: string): string[] {
  const why = decisions(page);
  const ids = [...new Set([...Object.keys(u.answers), ...u.ticks])].sort();
  const out = ids.map((id) => {
    const answer = u.answers[id];
    const ticked = u.ticks.includes(id);
    const what = [answer ? `answered: ${answer}` : '', ticked ? 'ticked' : ''].filter(Boolean).join(', ');
    const about = why.has(id) ? ` (decision: ${(why.get(id) as string).slice(0, 60)})` : '';
    return `ask ${id}${about} ${what}`;
  });
  if (u.priorities) out.push(`priorities edited inline: ${u.priorities.map((p, i) => `${i + 1}) ${p}`).join('; ') || '(emptied)'}`);
  return out;
}

export function check(target: string, _ctx?: Pick<CheckContext, 'now'>): StatusWatchState {
  const page = readPodium(target);
  if (page === null) return { sha: '', fresh: [] };
  const hash = sha(page);
  const baselineText = readSeenPage(target);
  if (baselineText !== null && sha(baselineText) === hash) return { sha: hash, fresh: [] };
  const meta = readSeenMeta(target);
  // The generator's own output, with no user edit copied into it, cannot hold an edit.
  const ownOutput = meta !== null && meta.generated_sha === hash && meta.carried === 0;
  const fields = extractFields(page);
  const fresh = ownOutput ? [] : describe(unprocessed(fields, baselineText === null ? null : extractFields(baselineText), meta ? meta.priorities_seen : undefined), page);
  writeSeenPage(target, page);
  writeSeenMeta(target, { generated_sha: meta?.generated_sha ?? '', carried: meta?.carried ?? 0, priorities_seen: fields.priorities });
  return { sha: hash, fresh };
}

export const diff = (_prev: StatusWatchState | null, next: StatusWatchState): WatchEvent[] => next.fresh.map((summary) => ({ summary, actionable: true }));
