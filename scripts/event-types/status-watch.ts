/**
 * status-watch: wakes the orchestrator when the user edits the status page by hand. Target is the status directory
 * (the one holding The-Podium.md); see scripts/lib/status-page/inline.ts for what counts as an edit: an `> answer:` line under
 * an ask, a `> discuss:` line under an ask, a ticked `- [x]` box on an ask, or a changed priorities list.
 *
 * An edit is held back until the page has been unchanged for SETTLE_MS (20 s), so a half-typed answer is not reported; the
 * baseline stays put meanwhile, so the edit is still new on the check that finds the page settled.
 *
 * Before the baseline moves, every edit is written to the ledger (`answer` and `discuss` rows, lib/journal/answers.ts) when the
 * ledger for this status directory is known, so the answer outlives the next regeneration and a dead session; the page renders
 * it back from there; a page answer that only repeats the ledger's latest answer for that ask is that rendering, and is not reported. If that write throws, the baseline stays and the edit is found again on the next check.
 *
 * Each check compares The-Podium.md with the baseline beside it (`.now-seen.md`) and reports only what is new, one actionable
 * event per ask (answer and tick together) and one for the priorities, then adopts The-Podium.md as the new baseline. A page the
 * generator wrote itself is recognised by its hash (`.now-seen.json`) and reported as nothing, so regenerating never fires.
 * The baseline moves in `check`, before the loop records the events: a crash in that instant loses the event, but not the
 * answer, which is already in the ledger (with no ledger known, only the page, until the next regeneration, holds it).
 * An answer given on the web page is already in the ledger (the route closes the ask) and is on the page too, so it is reported here once as
 * `answered on the page, already recorded and closed: ...` (see lib/web/answer-write.ts); an answer the session records itself with `resolve` never
 * touches the page, so it is never reported.
 * The digest cuts a summary at 300 characters, so the decision comes before the answer; a summary ending in `...` has the
 * full text in `.now-seen.md` (the baseline just adopted), under the same ask id.
 * State { sha, fresh } is the page hash and the summaries to report this tick; `fresh` is empty on every quiet check.
 * `add` refuses a target that is not an existing directory.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT, statusDirFor } from '../local-config.ts';
import { fold } from '../lib/ledger-core.ts';
import { latestRow, recordAnswer, squash } from '../lib/journal/answers.ts';
import { openStore } from '../lib/journal/store.ts';
import type { AnswerStore } from '../lib/journal/answers.ts';
import { extractFields, unprocessed } from '../lib/status-page/inline.ts';
import { PODIUM_FILE, readPodium, readSeenMeta, readSeenPage, sha, writeSeenMeta, writeSeenPage } from '../lib/status-page/seen.ts';
import type { Unprocessed } from '../lib/status-page/inline.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface StatusWatchState { sha: string; fresh: string[] }

// Scheduling: a local file read every 30 s (the local floor); no idle back-off. With the settle window below, an answer is reported within about a minute.
export const interval = 30;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;
// The user's own edits are not worth a phone buzz.
export const notifies = 'never' as const;

/** An edit is reported only once the page has not changed for this long, so an autosave mid-sentence is never taken for the answer. */
export const SETTLE_MS = 20_000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`status-watch target must be the status directory (the folder holding ${PODIUM_FILE}), got "${target}"`);
}

/** Ask id to the decision put to the user (the bold text on its ask line; the last cell of its row on an older table page), to say what an answer was about. */
function decisions(page: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of page.split('\n')) {
    const ask = line.match(/^- \[[ xX]\] `([a-z0-9]{4,6})` \*\*((?:\\.|[^\\])+?)\*\*/);
    if (ask) { out.set(ask[1] as string, (ask[2] as string).replace(/\\([\\*_`[\]<>])/g, '$1').trim()); continue; }
    const m = line.match(/^\| `([a-z0-9]{4,6})` \|(.*)\|\s*$/);
    const cells = (m?.[2] ?? '').split(/(?<!\\)\|/);
    if (m) out.set(m[1] as string, (cells[cells.length - 1] ?? '').replace(/\\\|/g, '|').trim());
  }
  return out;
}

/** One summary per ask that was answered or ticked, one per discuss mark (starting `DISCUSS`), then one for the priorities. */
export function describe(u: Unprocessed, page: string): string[] {
  const why = decisions(page);
  const ids = [...new Set([...Object.keys(u.answers), ...u.ticks])].sort();
  const out = ids.map((id) => {
    const answer = u.answers[id];
    const ticked = u.ticks.includes(id);
    const how = u.closed?.includes(id) ? 'answered on the page, already recorded and closed' : 'answered';
    const what = [answer ? `${how}: ${answer}` : '', ticked ? 'ticked' : ''].filter(Boolean).join(', ');
    const about = why.has(id) ? ` (decision: ${(why.get(id) as string).slice(0, 60)})` : '';
    return `ask ${id}${about} ${what}`;
  });
  // A discuss mark is its own event, tagged so the orchestrator raises it in chat and holds off acting on that ask.
  for (const id of Object.keys(u.discuss).sort()) {
    const about = why.has(id) ? ` (decision: ${(why.get(id) as string).slice(0, 60)})` : '';
    out.push(`DISCUSS ask ${id}${about}${u.discuss[id] ? `: ${u.discuss[id]}` : ' (no topic given)'}`);
  }
  if (u.priorities) out.push(`priorities edited inline: ${u.priorities.map((p, i) => `${i + 1}) ${p}`).join('; ') || '(emptied)'}`);
  return out;
}

/** Writes what a person did on the page into the ledger, at `nowMs`, and returns the edits that are really new. Throws when it cannot. */
export type Recorder = (edits: Unprocessed, nowMs: number) => Unprocessed;
/** The recorder for a status directory, or null when its ledger is not known (no ledger configured, or the directory is not the configured project's). */
export type RecorderFor = (target: string) => Recorder | null;

const RECORD_USAGE = { model: 'n/a', used: ['tool:status-watch'] };

/**
 * Records each answer, tick (as `(ticked)`, when it came with no words and the ask has no answer yet) and discuss mark against its open ask, one idempotent row each. An ask that is no longer open takes nothing: the event still fires.
 * Returns the edits to report: a page answer equal to the ledger's latest answer for that ask, from whichever source, is the generator's rendering coming back (the page was saved before the baseline caught up), not something said, so it is dropped.
 */
export function recordEdits(store: AnswerStore, edits: Unprocessed, nowMs: number): Unprocessed {
  const at = new Date(nowMs).toISOString();
  const row = (kind: 'answer' | 'discuss', ask: string, text: string): void => {
    recordAnswer(store, { kind, ask, text, source: 'page', usage: RECORD_USAGE, now: () => at, today: () => at.slice(0, 10) });
  };
  const entries = store.readLedger();
  const answers = Object.fromEntries(Object.entries(edits.answers).filter(([id, text]) => latestRow(entries, 'answer', id)?.text !== squash(text)));
  // An answer given through the web route is on the page as well as in the ledger's closing row: say so, so the session acts and does not resolve the ask again.
  const items = fold(entries, null).items;
  const closed = Object.entries(answers).filter(([id, text]) => items.find((i) => i.id === id)?.closedBy?.text === squash(text)).map(([id]) => id);
  const novel = { ...edits, answers, closed };
  // A bare tick says "as proposed", so it must not replace words already recorded for the ask.
  for (const id of new Set([...Object.keys(answers), ...edits.ticks])) {
    const text = answers[id] ?? (latestRow(entries, 'answer', id) ? null : '(ticked)');
    if (text !== null) row('answer', id, text);
  }
  for (const [id, topic] of Object.entries(edits.discuss)) row('discuss', id, topic);
  return novel;
}

/** The configured ledger, but only for the project whose status directory this is: an answer must never land in another project's ledger. */
export const recorderFor: RecorderFor = (target) => {
  const ledger = LEDGER_ROOT || VAULT_ROOT;
  const project = CONFIGURED_PROJECT || CONTAINER_PROJECT;
  const home = statusDirFor(project);
  if (!ledger || !home || resolve(home) !== resolve(target)) return null;
  const store = openStore({ vault: ledger, project, dryRun: false, warn: () => {} });
  return (edits, nowMs) => recordEdits(store, edits, nowMs);
};

export function check(target: string, ctx?: Pick<CheckContext, 'now'>, io?: RecorderFor): StatusWatchState {
  const page = readPodium(target);
  if (page === null) return { sha: '', fresh: [] };
  const hash = sha(page);
  const baselineText = readSeenPage(target);
  if (baselineText !== null && sha(baselineText) === hash) return { sha: hash, fresh: [] };
  const meta = readSeenMeta(target);
  // The generator's own output, with no user edit copied into it, cannot hold an edit.
  const ownOutput = meta !== null && meta.generated_sha === hash && meta.carried === 0;
  const fields = extractFields(page);
  const edits = ownOutput ? null : unprocessed(fields, baselineText === null ? null : extractFields(baselineText), meta ? meta.priorities_seen : undefined);
  const pending = edits ? describe(edits, page) : [];
  // A page still being typed into holds an edit that may be half a sentence: leave the baseline alone and look again next check.
  // Without a clock (a direct call) there is nothing to settle against.
  if (pending.length && ctx && ctx.now - statSync(join(target, PODIUM_FILE)).mtimeMs < SETTLE_MS) return { sha: hash, fresh: [] };
  // The ledger row comes first: a crash or a failed write here leaves the baseline alone, so the edit is found again next check.
  const reported = edits ? ((io ?? recorderFor)(target)?.(edits, ctx?.now ?? Date.now()) ?? edits) : null;
  writeSeenPage(target, page);
  writeSeenMeta(target, { generated_sha: meta?.generated_sha ?? '', carried: meta?.carried ?? 0, priorities_seen: fields.priorities });
  return { sha: hash, fresh: reported ? describe(reported, page) : [] };
}

export const diff = (_prev: StatusWatchState | null, next: StatusWatchState): WatchEvent[] => next.fresh.map((summary) => ({ summary, actionable: true }));
