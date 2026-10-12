/**
 * Triage of digest lines before the loop wakes the orchestrator. Deterministic rules classify the pr-watch (and pr-checks) lines:
 * the always-actionable ones wake, and any line no rule covers is "ambiguous". An ambiguous line still wakes for now, so behaviour is
 * unchanged; the point of this file is that every decision is made by a named rule and written down with its reason.
 *
 * Decisions go to `<event_dir>/triage.jsonl`, one JSON row per line, append-only. A row holds the watch, type, kind, the decision, the rule that made
 * it, a reason and the one-line summary (the same text the digest already holds; it never reaches the inbox).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toInboxEvent } from './event-inbox.ts';
import type { DigestEvent } from './types.ts';

/** Watch types whose lines this triage reads. Every other type is passed through untouched and unlogged. */
const TRIAGED_TYPES: ReadonlySet<string> = new Set(['pr-watch', 'pr-checks']);

/** `wake`: a rule says this is always actionable. `ambiguous`: no rule covers the line. */
export type RuleVerdict = 'wake' | 'ambiguous';

export interface RuleResult { verdict: RuleVerdict; rule: string; reason: string }

/** One decision as logged. `decision` is what happened to the line: it woke, or (never in this slice) was suppressed as noise. */
export interface TriageRow {
  at: string;
  watch: string;
  type: string;
  kind: string;
  decision: 'wake' | 'noise';
  rule: string;
  reason: string;
  summary: string;
}

export const triagePath = (eventDir: string): string => join(eventDir, 'triage.jsonl');

/** pr-watch tags lines for a self-review repo with this prefix; the rules read the line without it. */
const SELF_REVIEW_TAG = /^\[self-review\] /;

interface Rule { name: string; reason: string; applies: (line: string, kind: string, who: 'bot' | 'human' | undefined) => boolean }

/** The always-actionable rules, first match wins. Order is for the reader; each is independent. */
const WAKE_RULES: Rule[] = [
  { name: 'changes-requested', reason: 'a review requested changes', applies: (l, k) => k === 'changes-requested' || /^REVIEW \S+ by \S+ \(CHANGES_REQUESTED\)/.test(l) },
  { name: 'new-conflict', reason: 'the PR newly conflicts with its base', applies: (_l, k) => k === 'conflict' },
  { name: 'human-thread', reason: 'a person opened a new unresolved review thread', applies: (_l, k, who) => k === 'thread' && who === 'human' },
  { name: 'failed-check', reason: 'a check failed', applies: (l) => /^CHECKS-FAILING\b/.test(l) || /^CI failing\b/.test(l) },
];

/**
 * Classifies one digest line by the rules. A bot thread, reply, comment, plain review, approval or anything unrecognised is ambiguous.
 * "Required" is not visible in these lines: pr-checks reports a failing CI rollup and pr-watch a failing-checks line, and either wakes.
 */
export function classifyLine(event: Pick<DigestEvent, 'watch' | 'type' | 'at' | 'summary'>): RuleResult {
  const parsed = toInboxEvent({ ...event, actionable: true, report: '' });
  const line = String(event.summary).replace(SELF_REVIEW_TAG, '');
  const hit = WAKE_RULES.find((r) => r.applies(line, parsed?.kind ?? 'other', parsed?.fields.who));
  return hit ? { verdict: 'wake', rule: hit.name, reason: hit.reason } : { verdict: 'ambiguous', rule: 'no-rule', reason: 'no rule covers this line' };
}

/** Appends one row; a log that cannot be written must never stop the loop or hide an event, so a failure is reported on stderr only. */
export function logRow(eventDir: string, row: TriageRow | { row: 'sweep'; at: string }): void {
  try {
    mkdirSync(eventDir, { recursive: true });
    appendFileSync(triagePath(eventDir), `${JSON.stringify(row)}\n`);
  } catch (err) { console.error(`triage log not written: ${err instanceof Error ? err.message : String(err)}`); }
}

/**
 * Triage for the actionable lines of a tick: classify each, log the decision with its reason, and return the events. Slice 1 changes
 * nothing about waking: every line stays actionable, an ambiguous one included.
 */
export function triageEvents<T extends DigestEvent>(events: T[], opts: { dir: string }): T[] {
  for (const e of events) {
    if (!e.actionable || !TRIAGED_TYPES.has(e.type)) continue;
    const r = classifyLine(e);
    logRow(opts.dir, { at: e.at, watch: e.watch, type: e.type, kind: toInboxEvent({ ...e })?.kind ?? 'other', decision: 'wake', rule: r.rule, reason: r.verdict === 'wake' ? r.reason : `${r.reason}; wakes while ambiguous lines are not triaged`, summary: e.summary });
  }
  return events;
}
