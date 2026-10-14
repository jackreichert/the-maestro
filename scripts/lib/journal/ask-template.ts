/**
 * The template every ask that reaches the user must fill, like the fields of a ticket: a one-line question, what is blocked
 * until it is answered, the context, two or more options each with its cost, a recommendation, and at least one link.
 * (`--searched` and the door fields are checked by ask-gate.ts and ask-fields.ts.)
 *
 * Enforced where the row is written: `validateAskTemplate` returns every missing or malformed field, and `journal.ts ask`
 * writes nothing while the list is not empty. The two writers that do not go through the CLI (the roll's env-store ask) call
 * the same function, so no path to a queued ask skips it. Pure: the CLI hands in the flags, or the text of a `--body-file`.
 */

import { CONTROL, isText } from './ask-fields.ts';

/** What `ask` stores besides the question (the row's `text`) and the recommendation (`recommend`). */
export interface AskTemplate { blocked?: string; context?: string[]; options?: string[]; links?: string[] }

/** The template as the writer gave it: the question and recommendation are part of it, and stored elsewhere on the row. */
export interface AskTemplateInput extends AskTemplate { question?: string; recommend?: string }

export interface AskTemplateCheck { errors: string[]; template: AskTemplate }

export const QUESTION_MAX = 3000;
export const ITEM_MAX = 600;
export const LIST_MAX = 10;
/** A link the Podium can open: https, or an obsidian note. Anything else is text, not a link. */
const URL_IN_LINK = /(?:https:\/\/|obsidian:\/\/)[^\s<>"')\]]+/i;
/** A link to the project's own docs, for asks the tooling raises itself and that have no PR, ticket or note to point at. */
export const SYSTEM_LINK = 'https://github.com/jackreichert/the-maestro#readme';
/** `<option> -- <cost>`: the separator that says an option names its cost. */
const COST_SEPARATOR = /\s(?:--|—|–)\s/;

/** The URL in one link entry (`https://x`, `[label](https://x)` or `label: https://x`) and its label; null when it has no https or obsidian URL. */
export function parseLink(entry: string): { label: string; url: string } | null {
  const m = URL_IN_LINK.exec(entry);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?]+$/, '');
  const label = entry.replace(m[0], '').replace(/[[\]()<>]/g, '').replace(/[\s:–—-]+$/, '').replace(/^[\s:–—-]+/, '').trim();
  return { label: label || url, url };
}

/** The option and its cost, split at the first ` -- ` (or an em dash); cost is null when the option names none. */
export function splitOption(entry: string): { option: string; cost: string | null } {
  const m = COST_SEPARATOR.exec(entry);
  if (!m) return { option: entry.trim(), cost: null };
  return { option: entry.slice(0, m.index).trim(), cost: entry.slice(m.index + m[0].length).trim() || null };
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cleanAll = (xs: string[] | undefined): string[] => (xs ?? []).map(clean).filter(Boolean);

function listProblems(name: string, items: string[], out: string[]): void {
  if (items.length > LIST_MAX) out.push(`${name}: at most ${LIST_MAX} entries, got ${items.length}.`);
  items.forEach((s, i) => {
    if (CONTROL.test(s)) out.push(`${name} ${i + 1} has a control character: plain text only.`);
    else if (s.length > ITEM_MAX) out.push(`${name} ${i + 1} is over ${ITEM_MAX} characters: say it shorter.`);
  });
}

/**
 * Every problem with the template, named by the flag and the heading that supplies it, so one refusal says all that is
 * missing. `requireLinks` is false only for asks the tooling raises itself (they pass SYSTEM_LINK instead).
 */
export function validateAskTemplate(input: AskTemplateInput): AskTemplateCheck {
  const errors: string[] = [];
  const question = clean(input.question ?? '');
  const blocked = clean(input.blocked ?? '');
  const context = cleanAll(input.context);
  const options = cleanAll(input.options);
  const links = cleanAll(input.links);
  const recommend = clean(input.recommend ?? '');

  if (!question) errors.push('question: missing. Give the ask as one line (the text after `ask`, or "## Question" in --body-file).');
  else if (/[\r\n]/.test((input.question ?? '').trim())) errors.push('question: one line only; the detail goes in --context.');
  else if (CONTROL.test(question)) errors.push('question has a control character: plain text only.');
  else if (question.length > QUESTION_MAX) errors.push(`question is over ${QUESTION_MAX} characters: one line, shorter; the detail goes in --context.`);

  if (!blocked) errors.push('blocked: missing. Say what waits on the answer (--blocked "<what is blocked>", or "## What is blocked").');
  else if (CONTROL.test(blocked)) errors.push('blocked has a control character: plain text only.');
  else if (blocked.length > ITEM_MAX) errors.push(`blocked is over ${ITEM_MAX} characters: say it shorter.`);

  if (options.length < 2) errors.push(`options: ${options.length} given, at least 2 needed, each with its cost (--option "<option> -- <cost>" repeated, or "## Options" bullets).`);
  options.forEach((o, i) => { if (!splitOption(o).cost) errors.push(`option ${i + 1} ("${o.slice(0, 40)}") names no cost: write "<option> -- <cost or tradeoff>".`); });

  if (!recommend) errors.push('recommend: missing. Say what you would do and why (--recommend "<what and why>", or "## Recommendation").');

  if (!links.length) errors.push('links: none given, at least 1 needed: a PR, a ticket or an obsidian:// note (--link <url> repeated, or "## Links").');
  links.forEach((l, i) => { if (!parseLink(l)) errors.push(`link ${i + 1} ("${l.slice(0, 40)}") has no https:// or obsidian:// URL, so it cannot be opened.`); });

  listProblems('context', context, errors);
  listProblems('option', options, errors);
  listProblems('link', links, errors);

  return { errors, template: errors.length ? {} : { blocked, ...(context.length ? { context } : {}), options, links } };
}

// ── the --body-file form ────────────────────────────────────────────────────

const HEADINGS: [RegExp, keyof AskTemplateInput | 'searched' | 'door'][] = [
  [/^question$/i, 'question'], [/^what is blocked$|^blocked$/i, 'blocked'], [/^context$/i, 'context'], [/^options?$/i, 'options'],
  [/^recommendation$|^recommend$/i, 'recommend'], [/^links?$/i, 'links'], [/^what i checked$|^searched$/i, 'searched'], [/^door$/i, 'door'],
];

/** What a body file held: the template fields, plus the `searched` and `door` sections the other rule tables check. */
export interface ParsedBody extends AskTemplateInput { searched?: string; door?: string; unknown: string[] }

/** The bullets of a section (`- `, `* `, `1. `, or one per line); an indented or plain continuation line joins the bullet above it. */
function bullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) out.push(m[1]);
    else if (out.length && /^\s/.test(raw)) out[out.length - 1] += ` ${line}`;
    else out.push(line);
  }
  return out;
}

/** Parse the markdown of a `--body-file`: headings (`#` to `###`) name the sections; an unrecognised heading is reported, not dropped silently. */
export function parseAskBody(markdown: string): ParsedBody {
  const sections = new Map<string, string[]>();
  const unknown: string[] = [];
  let current: string | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const hit = HEADINGS.find(([re]) => re.test(h[1].trim()));
      current = hit ? (hit[1] as string) : null;
      if (hit && !sections.has(current as string)) sections.set(current as string, []);
      if (!hit) unknown.push(h[1].trim());
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }
  const text = (k: string): string | undefined => { const v = (sections.get(k) ?? []).map((l) => l.trim()).filter(Boolean).join(' '); return v || undefined; };
  const list = (k: string): string[] | undefined => (sections.has(k) ? bullets(sections.get(k) ?? []) : undefined);
  return {
    question: text('question'), blocked: text('blocked'), recommend: text('recommend'), searched: text('searched'), door: text('door'),
    context: list('context'), options: list('options'), links: list('links'), unknown,
  };
}

/** The writer's flags win over the file, field by field; a list given by flag replaces the file's list. */
export function mergeTemplate(flags: AskTemplateInput, file: AskTemplateInput): AskTemplateInput {
  const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => (Array.isArray(a) ? (a.length ? a : b) : isText(a) ? a : b);
  return {
    question: pick(flags.question, file.question), blocked: pick(flags.blocked, file.blocked), recommend: pick(flags.recommend, file.recommend),
    context: pick(flags.context, file.context), options: pick(flags.options, file.options), links: pick(flags.links, file.links),
  };
}

// ── reading a row back ──────────────────────────────────────────────────────

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : []);

/** The template of a stored row, each part read defensively; null for an older ask that carries none (it renders in the legacy layout). */
export function askTemplateOf(r: { blocked?: unknown; context?: unknown; options?: unknown; links?: unknown }): Required<AskTemplate> | null {
  const blocked = typeof r.blocked === 'string' ? r.blocked.trim() : '';
  const options = strList(r.options);
  if (!blocked && !options.length) return null;
  return { blocked, context: strList(r.context), options, links: strList(r.links) };
}

/** Problems with the template fields of one stored row, for `verify`: a hand edit the write-time rules would have refused. */
export function askTemplateProblems(r: { blocked?: unknown; context?: unknown; options?: unknown; links?: unknown }): string[] {
  const out: string[] = [];
  if (r.blocked !== undefined && typeof r.blocked !== 'string') out.push('blocked is not text');
  for (const f of ['context', 'options', 'links'] as const) {
    const v = r[f];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) out.push(`${f} is not a list of text`);
  }
  return out;
}
