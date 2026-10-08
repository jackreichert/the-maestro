/** The library-check rules, one object per rule, so adding a rule is adding a row. Each returns the problems it finds in one page. */
import { bodyLinks, list, text } from './page.ts';
import type { Page } from './page.ts';
import { scanText } from './scan.ts';
import type { Scanner } from './scan.ts';

export const KINDS = ['how-to', 'how-it-works', 'runbook', 'decision', 'gotcha', 'tool'] as const;
export const STATUSES = ['current', 'stale', 'superseded'] as const;
export const REQUIRED_FIELDS = ['type', 'kind', 'repo', 'stream', 'components', 'status', 'verified-at', 'verify-how', 'composed-by'] as const;
export const MAX_LINES = 150;
const VERIFIED_AT = /^\d{4}-\d{2}-\d{2}(@[0-9a-f]{7,40})?$/;
const FACT_END = /\(verified \d{4}-\d{2}-\d{2}, [^)]*\S[^)]*\)\.?\s*$/;

export interface Finding { rule: string; message: string; line?: number }
/** What a rule may ask about the vault around the page. */
export interface Context {
  /** The project folder the page sits in. */
  project: string;
  /** Every folder under `Projects/`. */
  repos: ReadonlySet<string>;
  /** The component list of the page's repo (`Projects/<repo>/INDEX.md`), or null when that file has none. */
  components: ReadonlySet<string> | null;
  /** Whether a link target (a vault path or a note name; the page checks frontmatter links and body wikilinks with it) resolves to a note in the vault. */
  resolves: (ref: string) => boolean;
  scan: Scanner;
}
export interface Rule { id: string; check: (page: Page, ctx: Context) => Finding[] }

const found = (rule: string, message: string, line?: number): Finding => ({ rule, message, ...(line ? { line } : {}) });
/** A page value as it may appear in a message: only short, plain-looking text the scanner finds nothing in; anything else is not printed, since a field can hold a secret. */
const show = (v: string, scan: Scanner): string => (/^[A-Za-z0-9._/ -]{1,60}$/.test(v) && !scan(v).length ? `"${v}"` : '(value not shown)');
const oneOf = (v: string, allowed: readonly string[]): boolean => allowed.includes(v);

/** The body split into sections by `## ` headings: heading text (lowercase) to its lines with 1-based file line numbers. */
export function sections(p: Page): Map<string, { line: number; text: string }[]> {
  const out = new Map<string, { line: number; text: string }[]>();
  let current = '';
  p.lines.forEach((t, i) => {
    if (i < p.bodyStart) return;
    const h = t.match(/^##\s+(.+?)\s*$/);
    if (h) { current = (h[1] as string).toLowerCase(); out.set(current, out.get(current) ?? []); return; }
    out.get(current)?.push({ line: i + 1, text: t });
  });
  return out;
}
/** The fact lines of a section: every non-blank line that is not a heading. A bullet, a numbered item and a prose line are all facts. */
const factLines = (s: { line: number; text: string }[] | undefined): { line: number; text: string }[] => (s ?? []).filter((l) => l.text.trim() !== '' && !/^\s{0,3}#{1,6}(\s|$)/.test(l.text));
const bullets = (s: { line: number; text: string }[] | undefined): { line: number; text: string }[] => (s ?? []).filter((l) => /^\s*[-*]\s+\S/.test(l.text));

export const RULES: readonly Rule[] = [
  {
    id: 'frontmatter',
    check: (p) => (p.hasFrontmatter
      ? [...REQUIRED_FIELDS.filter((k) => !text(p, k) && !list(p, k).length).map((k) => found('frontmatter', `missing required field "${k}"`)),
        ...(text(p, 'type') && text(p, 'type') !== 'library' ? [found('frontmatter', '"type" must be "library"')] : [])]
      : [found('frontmatter', 'the page has no frontmatter block')]),
  },
  {
    id: 'vocabulary',
    check: (p) => [
      ...(text(p, 'kind') && !oneOf(text(p, 'kind'), KINDS) ? [found('vocabulary', `kind is not one of ${KINDS.join(', ')}`)] : []),
      ...(text(p, 'status') && !oneOf(text(p, 'status'), STATUSES) ? [found('vocabulary', `status is not one of ${STATUSES.join(', ')}`)] : []),
    ],
  },
  {
    id: 'repo',
    check: (p, c) => {
      const repo = text(p, 'repo');
      if (!repo) return [];
      if (!c.repos.has(repo)) return [found('repo', `repo ${show(repo, c.scan)} is not a project in the vault (known: ${[...c.repos].sort().join(', ') || 'none'})`)];
      return repo === c.project ? [] : [found('repo', `repo ${show(repo, c.scan)} does not match the project folder "${c.project}" the page lives in`)];
    },
  },
  {
    id: 'components',
    check: (p, c) => {
      const used = list(p, 'components');
      if (!used.length) return [];
      if (!c.components) return [found('components', `Projects/${c.project}/INDEX.md has no components list, so no component can be checked`)];
      const known = c.components;
      return used.filter((x) => !known.has(x)).map((x) => found('components', `unknown component ${show(x, c.scan)} (known for ${c.project}: ${[...known].sort().join(', ')}); adding one is an edit to INDEX.md`));
    },
  },
  {
    id: 'verified-at',
    check: (p) => (text(p, 'verified-at') && !VERIFIED_AT.test(text(p, 'verified-at')) ? [found('verified-at', `verified-at must be YYYY-MM-DD, optionally followed by @<sha>`)] : []),
  },
  {
    id: 'facts',
    check: (p) => {
      const s = sections(p);
      const facts = factLines(s.get('facts'));
      return [
        ...(p.lines.slice(p.bodyStart).some((l) => /^Read when:\s*\S/.test(l)) ? [] : [found('facts', 'no "Read when:" line')]),
        ...(facts.length ? [] : [found('facts', 'the "## Facts" section has no fact')]),
        ...facts.filter((f) => !FACT_END.test(f.text)).map((f) => found('facts', 'a fact (every non-blank line under Facts that is not a heading) must end "(verified YYYY-MM-DD, <evidence>)"', f.line)),
      ];
    },
  },
  {
    id: 'size',
    check: (p) => {
      const s = sections(p);
      return [
        ...(p.lines.length > MAX_LINES ? [found('size', `${p.lines.length} lines; a page stays under ${MAX_LINES}, split it`)] : []),
        ...(bullets(s.get('history')).length > bullets(s.get('facts')).length ? [found('size', 'History is longer than Facts: the page is turning into a diary')] : []),
      ];
    },
  },
  {
    id: 'links',
    check: (p, c) => [
      ...(text(p, 'status') === 'superseded' && !list(p, 'superseded-by').length ? [found('links', 'status is superseded but superseded-by is empty')] : []),
      ...['supersedes', 'superseded-by', 'depends-on'].flatMap((k) => list(p, k).filter((ref) => !c.resolves(ref)).map((ref) => found('links', `${k} ${show(ref, c.scan)} does not resolve to a page`))),
      ...bodyLinks(p).filter((l) => !c.resolves(l.target)).map((l) => found('links', `link ${show(l.target, c.scan)} does not resolve to a note in the vault`, l.line)),
    ],
  },
  {
    id: 'secrets',
    check: (p, c) => c.scan(p.lines.join('\n')).map((h) => found('secrets', `${h.rule} shape (the match is not printed)`, h.line)),
  },
];

export function checkPage(p: Page, ctx: Omit<Context, 'scan'> & { scan?: Scanner }, rules: readonly Rule[] = RULES): Finding[] {
  const full: Context = { ...ctx, scan: ctx.scan ?? scanText };
  return rules.flatMap((r) => r.check(p, full));
}
