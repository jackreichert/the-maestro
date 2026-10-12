/**
 * Triage of digest lines before the loop wakes the orchestrator. Deterministic rules classify the pr-watch (and pr-checks) lines:
 * the always-actionable ones wake, and any line no rule covers is "ambiguous". An ambiguous line still wakes for now, so behaviour is
 * unchanged; the point of this file is that every decision is made by a named rule and written down with its reason.
 *
 * An ambiguous line then goes through a triage seam (`Triage`) that answers actionable, noise or unsure. Only a noise answer with a reason
 * stops a wake; unsure, a missing reason, a throw or any other answer wakes. The default seam is rules-only and always answers unsure, so
 * nothing is suppressed until a real triage (for example a small model) is passed in. Every noise decision is logged, and an hourly sweep
 * reports what was suppressed.
 *
 * Decisions go to `<event_dir>/triage.jsonl`, one JSON row per line, append-only. A row holds the watch, type, kind, the decision, the rule that made
 * it, a reason and the one-line summary (the same text the digest already holds; it never reaches the inbox).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toInboxEvent } from './event-inbox.ts';
import { oneLine } from './notify.ts';
import { STEER_FAILING_CHECK } from './steer-line.ts';
import type { DigestEvent } from './types.ts';

/** Watch types whose lines this triage reads. Every other type is passed through untouched and unlogged. */
const TRIAGED_TYPES: ReadonlySet<string> = new Set(['pr-watch', 'pr-checks']);

/** The loop's own health lines (a watch gone blind, a watch expired). They are never triaged: they always wake, whatever a seam would say. */
const UNTRIAGED_KINDS: ReadonlySet<string> = new Set(['check-failing', 'watch-expired']);

/** `wake`: a rule says this is always actionable. `ambiguous`: no rule covers the line. */
export type RuleVerdict = 'wake' | 'ambiguous';

export interface RuleResult { verdict: RuleVerdict; rule: string; reason: string }

/** One decision as logged. `decision` is what happened to the line: it woke, or was suppressed as noise. */
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
  { name: 'failed-check', reason: 'a check failed', applies: (l) => /^CHECKS-FAILING\b/.test(l) || /^CI failing\b/.test(l) || STEER_FAILING_CHECK.test(l) },
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

/** What the triage seam is shown for one ambiguous line. */
export interface TriageInput { watch: string; type: string; kind: string; summary: string }

/** The seam's answer. Only `noise` with a non-empty reason suppresses; `unsure` and `actionable` wake. */
export interface TriageAnswer { verdict: 'actionable' | 'noise' | 'unsure'; reason: string }

export type Triage = (line: TriageInput) => TriageAnswer;

/** The default seam: no model is wired, so it cannot tell noise from signal and says so. Every ambiguous line therefore wakes. */
export const rulesOnlyTriage: Triage = () => ({ verdict: 'unsure', reason: 'rules-only triage cannot classify this line' });

/** Runs the seam and holds it to its contract: a throw, a bad verdict or a noise answer with no reason is unsure. */
function ask(triage: Triage, input: TriageInput): TriageAnswer {
  try {
    const a = triage(input);
    const reason = typeof a?.reason === 'string' ? oneLine(a.reason, 200) : '';
    if (a?.verdict === 'noise') return reason ? { verdict: 'noise', reason } : { verdict: 'unsure', reason: 'triage said noise without a reason' };
    if (a?.verdict === 'actionable' || a?.verdict === 'unsure') return { verdict: a.verdict, reason: reason || 'no reason given' };
    return { verdict: 'unsure', reason: 'triage returned an unknown verdict' };
  } catch (err) { return { verdict: 'unsure', reason: `triage failed: ${oneLine(err instanceof Error ? err.message : String(err), 120)}` }; }
}

/**
 * Triage for the actionable lines of a tick. Each is classified by the rules and the decision logged with its reason. An ambiguous line goes to
 * the seam: noise (with a reason) turns the event into an info line that does not wake; anything else keeps it actionable. Returns the same events.
 */
export function triageEvents<T extends DigestEvent>(events: T[], opts: { dir: string; triage?: Triage }): T[] {
  const triage = opts.triage ?? rulesOnlyTriage;
  for (const e of events) {
    if (!e.actionable || !TRIAGED_TYPES.has(e.type)) continue;
    const kind = toInboxEvent({ ...e })?.kind ?? 'other';
    if (UNTRIAGED_KINDS.has(kind)) continue;
    const base = { at: e.at, watch: e.watch, type: e.type, kind, summary: e.summary };
    const r = classifyLine(e);
    if (r.verdict === 'wake') { logRow(opts.dir, { ...base, decision: 'wake', rule: r.rule, reason: r.reason }); continue; }
    const a = ask(triage, { watch: e.watch, type: e.type, kind, summary: e.summary });
    if (a.verdict === 'noise') {
      e.actionable = false;
      e.report = '';
      logRow(opts.dir, { ...base, decision: 'noise', rule: 'triage', reason: a.reason });
    } else logRow(opts.dir, { ...base, decision: 'wake', rule: a.verdict === 'actionable' ? 'triage' : 'no-rule', reason: a.verdict === 'actionable' ? a.reason : `${r.reason}; ${a.reason}` });
  }
  return events;
}

export const SWEEP_EVERY_MS = 3600 * 1000;

type Row = Partial<TriageRow> & { row?: string };

/** The parsed rows of the log, oldest first; a torn or foreign line is skipped. */
export function readTriageLog(eventDir: string): Row[] {
  const file = triagePath(eventDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l) as Row] : []; } catch { return []; } });
}

/** The noise decisions logged since `sinceMs` (all of them when omitted), oldest first. */
export const suppressedSince = (eventDir: string, sinceMs = 0): TriageRow[] => readTriageLog(eventDir)
  .filter((r): r is TriageRow => r.decision === 'noise' && Date.parse(String(r.at)) >= sinceMs);

/**
 * The hourly suppressed-lines sweep. When an hour has passed since the last sweep marker, it appends a new marker and returns one info event
 * listing the noise decisions since that marker (null when there were none, or when it is not due). A first run with no log does nothing.
 * The marker makes it idempotent: a restart does not repeat a sweep, and no suppressed line is listed twice.
 */
export function sweepSuppressed(eventDir: string, now: number, everyMs = SWEEP_EVERY_MS): DigestEvent | null {
  const rows = readTriageLog(eventDir);
  if (!rows.length) return null;
  const marks = rows.filter((r) => r.row === 'sweep').map((r) => Date.parse(String(r.at)));
  const last = marks.length ? Math.max(...marks) : 0;
  if (last && now - last < everyMs) return null;
  const noise = rows.filter((r): r is TriageRow => r.decision === 'noise' && Date.parse(String(r.at)) > last);
  logRow(eventDir, { row: 'sweep', at: new Date(now).toISOString() });
  if (!noise.length) return null;
  const why = [...new Set(noise.map((r) => r.reason))].slice(0, 3).join('; ');
  return { watch: 'triage', type: 'triage-sweep', at: new Date(now).toISOString(), actionable: false, report: '',
    summary: oneLine(`TRIAGE-SWEEP ${noise.length} line${noise.length === 1 ? '' : 's'} suppressed as noise since the last sweep (${why}); list them with: event-loop.ts triage-log --suppressed`, 300) };
}
