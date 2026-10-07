/**
 * PR BODY: the pure checks pr-open.ts runs on a PR body before it opens anything (reference/git.md, "PR body").
 * No I/O here, so every rule is unit-testable on a string.
 */
import {
  PR_BODY_SECTIONS, PR_BODY_CHECK_RISK, PR_BODY_CHECK_VERIFY, PR_BODY_CHECK_FORBIDDEN, PR_BODY_CHECK_DIAGRAM, PR_DIAGRAM_MIN_FILES,
} from './local-config.ts';

/** Which rules run. Each switch maps to a local-config key (`pr_body_*`); the defaults are the configured values. */
export interface BodyRules { sections: string[]; risk: boolean; verify: boolean; forbidden: boolean; diagram: boolean; diagramMinFiles: number }
/** What the diff says about the PR, for the rules that need it. */
export interface BodyContext { stacked: boolean; codeFiles: number }

export const DEFAULT_RULES: BodyRules = {
  sections: PR_BODY_SECTIONS, risk: PR_BODY_CHECK_RISK, verify: PR_BODY_CHECK_VERIFY, forbidden: PR_BODY_CHECK_FORBIDDEN,
  diagram: PR_BODY_CHECK_DIAGRAM, diagramMinFiles: PR_DIAGRAM_MIN_FILES,
};

const PLACEHOLDER = /^(?:[-*_\s.]*(?:tbd|todo|n\/a|none|fill (?:me )?in|wip)[-*_\s.]*|[-*_\s.]*)$/i;
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;

/** Patterns a PR body must not carry. Best effort: a pass is not a guarantee. The match is never printed, only the name. */
const FORBIDDEN: [string, RegExp][] = [
  ['an AI attribution line', /co-authored-by:|generated with \[?claude|assisted by (?:claude|copilot|an? ai)|\u{1F916}\s*generated/iu],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['a credential assignment', /\b(?:api[_-]?key|secret|passw(?:or)?d|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,}/i],
  ['an SSN-shaped number', /\b\d{3}-\d{2}-\d{4}\b/],
  ['a medical record number', /\bMRN\s*[:#]?\s*\d{4,}/i],
];

/** The text under each `##` title, to the next `#` or `##` heading; headings in fenced code or HTML comments are ignored. Fence lines stay in the text. */
function sectionsOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  let fence = '';
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && !fence) fence = mark[0];
    else if (mark && mark[0] === fence) fence = '';
    const heading = fence || mark ? null : /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1] === '##' ? heading[2].toLowerCase() : '';
      if (current) out.set(current, out.get(current) ?? '');
    } else if (current) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

const hasContent = (text: string): boolean => text.split('\n').some((l) => !FENCE_LINE.test(l) && !PLACEHOLDER.test(l.trim()));

/** True when the section is `n/a` followed by a reason, the way a template slot is skipped on purpose. */
const naWithReason = (text: string): boolean => /^\s*n\/a\b[\s,:;.-]*\S/i.test(text.trim());

/** True when the text holds a fenced block with at least one non-blank line inside. */
function hasFilledFence(text: string): boolean {
  let open = '';
  let filled = false;
  for (const line of text.split('\n')) {
    const mark = FENCE_LINE.exec(line)?.[0].trim();
    if (mark && !open) { open = mark[0]; filled = false; }
    else if (mark && open && mark[0] === open) { if (filled) return true; open = ''; }
    else if (open && line.trim()) filled = true;
  }
  return false;
}

const sectionMatching = (sections: Map<string, string>, re: RegExp): string | undefined => [...sections].find(([k]) => re.test(k))?.[1];

function riskProblems(sections: Map<string, string>): string[] {
  const text = sectionMatching(sections, /^risk/);
  if (text === undefined) return [];
  const level = /^[\s>*_-]*\**risk\**\s*:\s*\**\s*(low|medium|high)\b/im.exec(text)?.[1].toLowerCase();
  if (!level) return ['the risk section has no "Risk: low | medium | high" line'];
  if (level !== 'high') return [];
  const rollback = sectionMatching(sections, /^rollback/);
  return rollback !== undefined && hasContent(rollback) && !naWithReason(rollback) ? [] : ['Risk is high, so the rollback section must say how to undo it (not empty, not n/a)'];
}

function verifyProblems(sections: Map<string, string>): string[] {
  const text = sectionMatching(sections, /^how to verify/);
  if (text === undefined || naWithReason(text) || hasFilledFence(text)) return [];
  return ['the verify section has no fenced code block with a command (or "n/a, <reason>")'];
}

const forbiddenProblems = (body: string): string[] => FORBIDDEN.filter(([, re]) => re.test(body)).map(([what]) => `the body contains ${what}`);

function diagramProblems(body: string, ctx: BodyContext, min: number): string[] {
  if (!ctx.stacked && ctx.codeFiles <= min) return [];
  if (/^\s*(`{3,}|~{3,})\s*mermaid\b/im.test(body) || /^\s*[-*]?\s*\**diagram\**\s*:\s*\**\s*n\/a\b[\s,:;.-]*\S/im.test(body)) return [];
  return [`a ${ctx.stacked ? 'stacked PR' : `PR over ${min} code files`} needs a mermaid diagram or a "Diagram: n/a, <reason>" line`];
}

/** Problems that keep a PR body from opening: required sections with real content, then the structural rules. */
export function bodyProblems(body: string, rules: BodyRules = DEFAULT_RULES, ctx: BodyContext = { stacked: false, codeFiles: 0 }): string[] {
  const sections = sectionsOf(body);
  const missing = rules.sections.flatMap((name) => {
    const text = sections.get(name.toLowerCase());
    if (text === undefined) return [`missing a "## ${name}" section`];
    return hasContent(text) ? [] : [`"## ${name}" has no content (empty or a placeholder)`];
  });
  return [
    ...missing,
    ...(rules.risk ? riskProblems(sections) : []),
    ...(rules.verify ? verifyProblems(sections) : []),
    ...(rules.diagram ? diagramProblems(body, ctx, rules.diagramMinFiles) : []),
    ...(rules.forbidden ? forbiddenProblems(body) : []),
  ];
}
