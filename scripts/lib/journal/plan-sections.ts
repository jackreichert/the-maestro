/**
 * The planning sections a writer brief's details must carry: Invariants, Prior art and Prep refactor.
 * `journal.ts brief` refuses a writer brief without them, unless it is passed `--one-point` (a 1-point,
 * one-file change). Pure text checks; the command decides what to do with the problems.
 */

export const PLAN_SECTIONS = ['Invariants', 'Prior art', 'Prep refactor'] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

/** Values that fill a slot without saying anything. */
const PLACEHOLDER = /^(?:tbd|todo|tba|n\/?a|\.{2,}|…|<[^>]*>|_tbd_|-+)$/i;
/** A heading line, or a bold `**Label:**` line: the start of the next section. */
const BOUNDARY = /^\s*(?:#{1,6}\s|(?:[-*]\s+)?\*\*[^*]+\*\*)/;

/** A label line: `## Name`, `**Name:** text`, `- **Name:** text` or `Name: text`. A bare word at the start of a sentence is not a label, so the plain form needs its colon. */
const labelPattern = (name: string): RegExp =>
    new RegExp(`^\\s*(?:#{1,6}\\s+${name}\\b:?|(?:[-*]\\s+)?\\*\\*${name}:?\\*\\*:?|${name}:)\\s*(.*)$`, 'i');
const LABELS = PLAN_SECTIONS.map(labelPattern);

/** The text under one section label (same line after the label, then the lines until the next heading or label), or undefined when the label is absent. */
export function sectionBody(details: string, name: PlanSection): string | undefined {
    const lines = details.split('\n');
    const label = labelPattern(name);
    const at = lines.findIndex((l) => label.test(l));
    if (at < 0) return undefined;
    const body = [label.exec(lines[at] as string)?.[1] ?? ''];
    for (const l of lines.slice(at + 1)) { if (BOUNDARY.test(l) || LABELS.some((p) => p.test(l))) break; body.push(l); }
    return body.join('\n').trim();
}

/** What is wrong with the details' planning sections, one line per problem; empty when the brief may go out. */
export function planSectionProblems(details: string | undefined): string[] {
    const text = details ?? '';
    const problems: string[] = [];
    for (const name of PLAN_SECTIONS) {
        const body = sectionBody(text, name);
        if (body === undefined) problems.push(`no "${name}" section`);
        else if (!body || PLACEHOLDER.test(body)) problems.push(`"${name}" is empty or a placeholder`);
        else if (name === 'Prior art' && /^(?:none|nothing|n\/?a)\b\.?$/i.test(body)) problems.push('"Prior art" says nothing was read; name what you read and reuse it or say why not');
    }
    return problems;
}
