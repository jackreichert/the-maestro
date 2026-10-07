/**
 * PR BODY: the pure checks pr-open.ts runs on a PR body before it opens anything (reference/git.md, "PR body").
 * No I/O here, so every rule is unit-testable on a string.
 */
export const REQUIRED_SECTIONS = ['Context', 'Reviewer guide'];
const PLACEHOLDER = /^(?:[-*_\s.]*(?:tbd|todo|n\/a|none|fill (?:me )?in|wip)[-*_\s.]*|[-*_\s.]*)$/i;

/** The text under each `##` title, to the next `#` or `##` heading; fenced code and HTML comments are ignored. */
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
    } else if (current && !mark) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

/** Problems that keep a PR body from opening: each required section must exist with non-placeholder content. */
export function bodyProblems(body: string): string[] {
  const sections = sectionsOf(body);
  return REQUIRED_SECTIONS.flatMap((name) => {
    const text = sections.get(name.toLowerCase());
    if (text === undefined) return [`missing a "## ${name}" section`];
    const filled = text.split('\n').some((l) => !PLACEHOLDER.test(l.trim()));
    return filled ? [] : [`"## ${name}" has no content (empty or a placeholder)`];
  });
}
