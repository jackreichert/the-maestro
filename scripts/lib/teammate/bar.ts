/**
 * The lenient review bar for someone else's PR, and the shape of the review it produces, applied in code to whatever a reviewing agent hands back.
 *
 * A finding is BLOCKING only when it names one of three things and carries the evidence that thing needs:
 *   1. correctness: an `input` and the `failure` it produces (wrong output, crash or data loss), both written out;
 *   2. security: a `kind` from SECURITY_KINDS (a secret, PHI or PII, an auth or tenant-scoping hole, injection, a customer reference);
 *   3. rollback: a `kind` from ROLLBACK_KINDS (a destructive migration, a breaking API with no fallback).
 * Anything else, including a claim of one of those without its evidence, is a non-blocking suggestion, and at most MAX_SUGGESTIONS are kept.
 * Naming, style, nice-to-have tests and refactors can never be blocking: no category outside the three can reach that severity. The code cannot
 * judge whether the evidence is true; it makes sure it was stated, and the person still approves the whole review before it is posted.
 *
 * The result is ONE review draft: it opens with a specific compliment (required, and refused when generic), carries each finding as an inline comment
 * anchored to a line that is on the RIGHT side of the head commit's diff (a finding with no such line is dropped, never posted loose), and its event
 * is APPROVE when nothing blocks and REQUEST_CHANGES when something does. The closing line tells the author to resolve the suggestions however they
 * think best. A text is in the person's first person and may not mention an assistant or a tool: such a text is refused.
 */
import { createHash } from 'node:crypto';
import type { NewDraft, ReviewComment } from '../drafts/queue.ts';

export const MAX_SUGGESTIONS = 3;
export const SECURITY_KINDS = ['secret', 'phi-pii', 'auth', 'tenant-scope', 'injection', 'customer-reference'] as const;
export const ROLLBACK_KINDS = ['destructive-migration', 'breaking-api-no-fallback'] as const;
const MIN_EVIDENCE = 8;
const MIN_COMPLIMENT_WORDS = 6;

/** One finding as an agent reports it. Every field is untrusted. */
export interface Finding { category?: string; kind?: string; input?: string; failure?: string; path?: string; line?: number; text?: string }

export interface PrContext { repo: string; pr: number; head: string }
export interface Dropped { index: number; reason: string }
/** The lines of each file that are on the RIGHT side of the diff (added or context), by path. */
export type DiffLines = ReadonlyMap<string, ReadonlySet<number>>;

const TOOL_WORDS = /\b(?:ai|a\.i\.|assistant|claude|anthropic|copilot|llm|chatgpt|gpt|mithril|language model|auto-?generated|generated (?:by|with)|automated review|bot)\b/i;
const GENERIC = /^\s*(?:great|nice|good|solid|awesome|excellent|amazing|well)\b[\w\s,.!'-]{0,40}$/i;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Why a comment text may not be queued, or null. */
export function voiceProblem(text: string): string | null {
  if (!text) return 'no comment text';
  if (TOOL_WORDS.test(text)) return 'the comment mentions an assistant or a tool';
  return null;
}

/** Why a compliment is not acceptable, or null: it must name something specific that was done well, not a generic "nice work". */
export function complimentProblem(c: string | undefined): string | null {
  const text = str(c);
  if (!text) return 'a review needs a compliment: name one specific thing done well';
  const bad = voiceProblem(text);
  if (bad) return bad;
  if (text.split(/\s+/).length < MIN_COMPLIMENT_WORDS || GENERIC.test(text)) return 'the compliment is generic: name the specific thing that was done well';
  return null;
}

/** The severity this finding earns, and why it fell short when it claimed more. */
export function classify(f: Finding): { severity: 'blocking' | 'suggestion'; downgraded?: string } {
  const category = str(f.category).toLowerCase();
  const kind = str(f.kind).toLowerCase();
  if (category === 'correctness') {
    if (str(f.input).length >= MIN_EVIDENCE && str(f.failure).length >= MIN_EVIDENCE) return { severity: 'blocking' };
    return { severity: 'suggestion', downgraded: 'a correctness claim needs the input and the concrete failure' };
  }
  if (category === 'security') {
    if ((SECURITY_KINDS as readonly string[]).includes(kind)) return { severity: 'blocking' };
    return { severity: 'suggestion', downgraded: `security needs a kind from: ${SECURITY_KINDS.join(', ')}` };
  }
  if (category === 'rollback') {
    if ((ROLLBACK_KINDS as readonly string[]).includes(kind)) return { severity: 'blocking' };
    return { severity: 'suggestion', downgraded: `rollback needs a kind from: ${ROLLBACK_KINDS.join(', ')}` };
  }
  return { severity: 'suggestion' };
}

/** The RIGHT-side lines of a unified diff, by path: every added line and every context line of each hunk. */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { const p = raw.slice(4); lines = p === '/dev/null' ? null : out.get(p.replace(/^b\//, '')) ?? new Set(); if (lines) out.set(p.replace(/^b\//, ''), lines); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (!lines || next === 0) continue;
    if (raw.startsWith('+')) { lines.add(next); next += 1; } else if (raw.startsWith(' ')) { lines.add(next); next += 1; }
    else if (raw.startsWith('\\') || raw.startsWith('-')) continue;
    else next = 0;
  }
  return out;
}

const closing = (blocking: boolean, comments: number): string => {
  if (comments === 0) return 'Nothing here blocks this from my side.';
  const resolve = 'Resolve them however you think best: fix now, follow up later, or just resolve the thread if you disagree.';
  return blocking
    ? `I've asked for changes on the blocking comment(s) below; the rest are suggestions. ${resolve}`
    : `Approving. I left a few inline suggestions. ${resolve}`;
};

/** What `planReview` returns: the one draft (null when the compliment is refused), and every finding that was dropped or downgraded, with why. */
export interface ReviewPlan { draft: NewDraft | null; problem?: string; dropped: Dropped[]; downgraded: number }

/**
 * Builds the review draft for one PR head. `diff` is the head's diff lines; a finding off it is dropped. At most MAX_SUGGESTIONS suggestions are
 * kept (blocking ones never are dropped for the cap). The draft's key is the PR and head, so asking again for the same head queues nothing new.
 */
export function planReview(ctx: PrContext, compliment: string | undefined, findings: readonly Finding[], diff: DiffLines): ReviewPlan {
  const problem = complimentProblem(compliment);
  if (problem) return { draft: null, problem, dropped: [], downgraded: 0 };
  const dropped: Dropped[] = [];
  const comments: ReviewComment[] = [];
  let suggestions = 0;
  let downgraded = 0;
  findings.forEach((f, index) => {
    const text = str(f.text);
    const bad = voiceProblem(text);
    if (bad) { dropped.push({ index, reason: bad }); return; }
    const path = str(f.path);
    if (!path || !Number.isSafeInteger(f.line) || !diff.get(path)?.has(f.line as number)) { dropped.push({ index, reason: 'not anchored to a line in the diff' }); return; }
    const { severity, downgraded: why } = classify(f);
    if (why) downgraded += 1;
    if (severity === 'suggestion') {
      if (suggestions >= MAX_SUGGESTIONS) { dropped.push({ index, reason: `over the ${MAX_SUGGESTIONS}-suggestion limit for this PR` }); return; }
      suggestions += 1;
    }
    comments.push({ path, line: f.line as number, severity, text: `${severity === 'blocking' ? 'Blocking' : 'Suggestion'}: ${text}` });
  });
  const blocking = comments.some((c) => c.severity === 'blocking');
  const opening = str(compliment);
  const body = `${opening}\n\n${closing(blocking, comments.length)}`;
  const tail = voiceProblem(body);
  if (tail) return { draft: null, problem: tail, dropped, downgraded };
  return {
    draft: {
      key: `${ctx.repo}#${ctx.pr}@${ctx.head.slice(0, 12)}:review`, source: 'review', repo: ctx.repo, pr: ctx.pr, severity: 'review', text: body,
      target: { kind: 'review', commitId: ctx.head }, review: { compliment: opening, comments },
      context: `${blocking ? 'Requests changes' : 'Approves'}: ${comments.filter((c) => c.severity === 'blocking').length} blocking, ${comments.filter((c) => c.severity === 'suggestion').length} suggestion(s); ${createHash('sha1').update(body).digest('hex').slice(0, 6)}`,
    },
    dropped, downgraded,
  };
}
