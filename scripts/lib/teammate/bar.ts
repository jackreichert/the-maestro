/**
 * The lenient review bar for someone else's PR, and the shape of the review it produces, applied in code to whatever a reviewing agent hands back.
 *
 * A finding is BLOCKING only when it names one of three things and carries the evidence that thing needs:
 *   1. correctness: an `input` and the `failure` it produces (wrong output, crash or data loss), both written out;
 *   2. security: a `kind` from SECURITY_KINDS (a secret, PHI or PII, an auth or tenant-scoping hole, injection, a customer reference);
 *   3. rollback: a `kind` from ROLLBACK_KINDS (a destructive migration, a breaking API with no fallback).
 * Anything else, including a claim of one of those without its evidence, is a non-blocking suggestion, and at most MAX_SUGGESTIONS are kept.
 * A finding with `source: "smell"` (from the smells pass) is a suggestion whatever else it claims, must state its maintenance `cost`, is dropped when a
 * reviewer finding sits in the same file within SMELL_DEDUP_LINES lines, and counts against MAX_SMELL_SUGGESTIONS, never against MAX_SUGGESTIONS.
 * Naming, style, nice-to-have tests and refactors can never be blocking: no category outside the three can reach that severity. The code cannot
 * judge whether the evidence is true; it makes sure it was stated, and the person still approves the whole review before it is posted.
 *
 * The result is ONE review draft. When the caller hands in a `ReviewContext` (`submit` always does), the body opens with what the PR does, the ticket match and the
 * core logic links (context.ts), then the specific compliment (required, and refused when generic); carries each finding as an inline comment
 * anchored to a line that is on the RIGHT side of the head commit's diff (a finding with no such line is dropped, never posted loose), and its event
 * is APPROVE when nothing blocks and REQUEST_CHANGES when something does. The closing line tells the author to resolve the suggestions however they
 * think best. A text is in the person's first person and may not mention an assistant or a tool: such a text is refused.
 */
import { createHash } from 'node:crypto';
import { isLogin, MAX_TEXT } from '../drafts/queue.ts';
import type { NewDraft, ReviewComment } from '../drafts/queue.ts';
import { contextProblem, renderSummary } from './context.ts';
import type { ReviewContext } from './context.ts';

export const MAX_SUGGESTIONS = 3;
/** Smell suggestions have their own cap, so a smells pass can never crowd out the reviewer's findings. */
export const MAX_SMELL_SUGGESTIONS = 2;
/** A smell finding in the same file within this many lines of a reviewer finding is the same finding, and is dropped. */
export const SMELL_DEDUP_LINES = 3;
export const SECURITY_KINDS = ['secret', 'phi-pii', 'auth', 'tenant-scope', 'injection', 'customer-reference'] as const;
export const ROLLBACK_KINDS = ['destructive-migration', 'breaking-api-no-fallback'] as const;
const MIN_EVIDENCE = 8;
const MIN_COMPLIMENT_WORDS = 8;

/** One finding as an agent reports it. Every field is untrusted. */
export interface Finding { category?: string; kind?: string; input?: string; failure?: string; path?: string; line?: number; text?: string; source?: string; cost?: string }

export interface PrContext { repo: string; pr: number; head: string; /** The id of an earlier draft for this same head that this one replaces; it gives the new draft its own key. */ supersedes?: string; /** The PR author's login, recorded on the draft for the approval list. */ author?: string }
export interface Dropped { index: number; reason: string }
/** The lines of each file that are on the RIGHT side of the diff (added or context), by path. */
export type DiffLines = ReadonlyMap<string, ReadonlySet<number>>;

const TOOL_WORDS = /\b(?:as an? (?:ai|assistant|language model|bot)|i(?:'m| am) an? (?:ai|assistant|language model|bot)|an? (?:ai|llm) (?:wrote|generated|reviewed)|claude|anthropic|chatgpt|openai|llm|mithril|language model|auto-?generated|generated (?:by|with)|automated review|(?:review|comment) (?:was )?(?:written|generated) by)\b/i;
const GENERIC = /\b(?:lgtm|looks? (?:good|great|fine)|ship it|great (?:work|job|pr)|nice (?:work|job|pr)|good (?:work|job|pr)|well done|thanks? for (?:this|your) (?:pr|work|pull|contribution)|awesome|amazing|excellent work|solid (?:work|pr))\b/i;
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
  if (text.split(/\s+/).length < MIN_COMPLIMENT_WORDS || GENERIC.test(text.split(/\s+/).slice(0, 8).join(' '))) return 'the compliment is generic: name the specific thing that was done well';
  return null;
}

/** True for a finding the smells pass reported: it can never block, however it is labelled. */
export const isSmell = (f: Finding): boolean => str(f.source).toLowerCase() === 'smell';

/** The severity this finding earns, and why it fell short when it claimed more. */
export function classify(f: Finding): { severity: 'blocking' | 'suggestion'; downgraded?: string } {
  if (isSmell(f)) return { severity: 'suggestion' };
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

/** A path as git prints it in a `+++` header: C-quoted (with octal escapes) when it holds unusual bytes, else bare with a trailing tab when it holds a space. */
function headerPath(raw: string): string | null {
  let p = raw.replace(/\t.*$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes: number[] = [];
    const inner = p.slice(1, -1);
    const esc: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 };
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i] as string;
      if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
      const oct = /^[0-7]{3}/.exec(inner.slice(i + 1));
      if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; } else { bytes.push(esc[inner[i + 1] as string] ?? 63); i += 1; }
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p.replace(/^b\//, '');
}

/**
 * The RIGHT-side lines of a unified diff, by path: every added line and every context line of each hunk. Hunks are read by their line counts,
 * not by what a line looks like, so an added line that starts with `++ ` is content, never a file header; the `+++` header is only read between a
 * `diff --git` line and its first hunk.
 */
export function parseDiffLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  let header = false;
  let next = 0; let oldLeft = 0; let newLeft = 0;
  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === '+') { lines?.add(next); next += 1; newLeft -= 1; continue; }
      if (c === '-') { oldLeft -= 1; continue; }
      if (c === ' ') { lines?.add(next); next += 1; oldLeft -= 1; newLeft -= 1; continue; }
      if (c === '\\') continue;
      oldLeft = 0; newLeft = 0;
    }
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('diff --git ')) { header = true; lines = null; continue; }
    if (header && raw.startsWith('+++ ')) {
      const p = headerPath(raw.slice(4));
      lines = null;
      if (p !== null) { lines = out.get(p) ?? new Set(); out.set(p, lines); }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) { header = false; oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]); next = Number(hunk[2]); newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]); }
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
export function planReview(ctx: PrContext, compliment: string | undefined, findings: readonly Finding[], diff: DiffLines, context?: ReviewContext): ReviewPlan {
  const problem = complimentProblem(compliment);
  if (problem) return { draft: null, problem, dropped: [], downgraded: 0 };
  const ctxProblem = context ? contextProblem(context, diff) : null;
  if (ctxProblem) return { draft: null, problem: ctxProblem, dropped: [], downgraded: 0 };
  const dropped: Dropped[] = [];
  const comments: ReviewComment[] = [];
  let suggestions = 0;
  let smellSuggestions = 0;
  let downgraded = 0;
  let lostBlocker: string | null = null;
  const drop = (index: number, f: Finding, reason: string): void => {
    dropped.push({ index, reason });
    if (classify(f).severity === 'blocking') lostBlocker ??= `finding ${index + 1}: ${reason}`;
  };
  const reviewerAt = (path: string): number[] => findings.filter((g) => !isSmell(g) && str(g.path) === path && Number.isSafeInteger(g.line)).map((g) => g.line as number);
  // The reviewer's findings go first, so a smell can only fill room they left.
  const order = findings.map((f, index) => ({ f, index })).sort((a, b) => Number(isSmell(a.f)) - Number(isSmell(b.f)) || a.index - b.index);
  order.forEach(({ f, index }) => {
    const text = str(f.text);
    const bad = voiceProblem(text);
    if (bad) { drop(index, f, bad); return; }
    const path = str(f.path);
    if (!path || !Number.isSafeInteger(f.line) || !diff.get(path)?.has(f.line as number)) { drop(index, f, 'not anchored to a line in the diff'); return; }
    if (isSmell(f)) {
      if (str(f.cost).length < MIN_EVIDENCE) { drop(index, f, 'a smell needs the concrete maintenance cost it causes'); return; }
      if (reviewerAt(path).some((l) => Math.abs(l - (f.line as number)) <= SMELL_DEDUP_LINES)) { drop(index, f, 'the reviewer already raised this spot'); return; }
      if (smellSuggestions >= MAX_SMELL_SUGGESTIONS) { dropped.push({ index, reason: `over the ${MAX_SMELL_SUGGESTIONS}-smell limit for this PR` }); return; }
      smellSuggestions += 1;
      comments.push({ path, line: f.line as number, severity: 'suggestion', text: `Suggestion: ${text}` });
      return;
    }
    const { severity, downgraded: why } = classify(f);
    if (why) downgraded += 1;
    if (severity === 'suggestion') {
      if (suggestions >= MAX_SUGGESTIONS) { dropped.push({ index, reason: `over the ${MAX_SUGGESTIONS}-suggestion limit for this PR` }); return; }
      suggestions += 1;
    }
    comments.push({ path, line: f.line as number, severity, text: `${severity === 'blocking' ? 'Blocking' : 'Suggestion'}: ${text}` });
  });
  // A blocking finding that cannot be posted must never turn into an approval: the whole review waits until it is fixed and submitted again.
  if (lostBlocker) return { draft: null, problem: `a blocking finding could not be posted (${lostBlocker}); anchor it to a changed line and word it plainly, then submit again`, dropped, downgraded };
  const blocking = comments.some((c) => c.severity === 'blocking');
  const opening = str(compliment);
  const lead = context ? `${renderSummary(ctx.repo, ctx.head, context, [...comments].sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking')).map((c) => ({ blocking: c.severity === 'blocking', path: c.path, line: c.line, text: c.text.replace(/^(Blocking|Suggestion): /, '') })))}\n\n` : '';
  const body = `${lead}${opening}\n\n${closing(blocking, comments.length)}`;
  const tail = voiceProblem(body) ?? (body.length > MAX_TEXT ? `the review is ${body.length} characters; keep it under ${MAX_TEXT}: shorten the summary, ticket lists and core logic notes` : null);
  if (tail) return { draft: null, problem: tail, dropped, downgraded };
  return {
    draft: {
      key: `${ctx.repo}#${ctx.pr}@${ctx.head.slice(0, 12)}:review${ctx.supersedes ? `:redo-${ctx.supersedes}` : ''}`, source: 'review', repo: ctx.repo, pr: ctx.pr, severity: 'review', text: body,
      target: { kind: 'review', commitId: ctx.head }, ...(ctx.author && isLogin(ctx.author) ? { author: ctx.author } : {}), review: { compliment: opening, comments, ...(context ? { context } : {}) },
      context: `${blocking ? 'Requests changes' : 'Approves'}: ${comments.filter((c) => c.severity === 'blocking').length} blocking, ${comments.filter((c) => c.severity === 'suggestion').length} suggestion(s); ${createHash('sha1').update(body).digest('hex').slice(0, 6)}`,
    },
    dropped, downgraded,
  };
}
