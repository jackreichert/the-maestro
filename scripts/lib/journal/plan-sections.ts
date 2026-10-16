/**
 * The planning sections a writer brief's details must carry: Invariants, Prior art and Prep refactor.
 * `journal.ts brief` refuses a writer brief without them, unless it is passed `--one-point` (a 1-point,
 * one-file change). Pure text checks; the command decides what to do with the problems.
 */

export const PLAN_SECTIONS = ['Invariants', 'Prior art', 'Prep refactor'] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

/** A line that fills a slot without saying anything (after list markers and a trailing full stop are stripped). */
const PLACEHOLDER = /^(?:tbd|todo|tba|n\/?a|\.{2,}|…|—|–|-+|_tbd_)$/i;
/** An unfilled template slot such as `<what must hold>`. */
const TEMPLATE_SLOT = /<[^<>\n]+>/;
/** Prior art that says nothing was read. */
const NOTHING_READ = /^(?:none|nothing|n\/?a)(?:\s+found)?$/i;
/** A heading line, or a bold `**Label:**` line: the start of the next section. */
const BOUNDARY = /^\s*(?:#{1,6}\s|(?:[-*]\s+)?\*\*[^*]+\*\*)/;

/**
 * A label line: `## Name` (a heading's own text is not a value), `**Name:** text`, `- **Name:** text` or `Name: text`.
 * A bare word at the start of a sentence is not a label, so the plain form needs its colon.
 */
const LABELS: Record<PlanSection, { heading: RegExp; inline: RegExp }> = Object.fromEntries(PLAN_SECTIONS.map((name) => [name, {
    heading: new RegExp(`^\\s*#{1,6}\\s+${name}\\b`, 'i'),
    inline: new RegExp(`^\\s*(?:(?:[-*]\\s+)?\\*\\*${name}:?\\*\\*:?|${name}:)\\s*(.*)$`, 'i'),
}])) as Record<PlanSection, { heading: RegExp; inline: RegExp }>;
const isLabel = (line: string): boolean => PLAN_SECTIONS.some((n) => LABELS[n].heading.test(line) || LABELS[n].inline.test(line));

/** The lines under one section label (the text after an inline label, then the lines up to the next heading or label), or undefined when the label is absent. */
export function sectionLines(details: string, name: PlanSection): string[] | undefined {
    const lines = details.split(/\r?\n/);
    const { heading, inline } = LABELS[name];
    const at = lines.findIndex((l) => heading.test(l) || inline.test(l));
    if (at < 0) return undefined;
    const body = [inline.exec(lines[at] as string)?.[1] ?? ''];
    for (const l of lines.slice(at + 1)) { if (BOUNDARY.test(l) || isLabel(l)) break; body.push(l); }
    return body.map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()).filter(Boolean);
}

/** What is wrong with the details' planning sections, one line per problem; empty when the brief may go out. */
export function planSectionProblems(details: string | undefined): string[] {
    const problems: string[] = [];
    for (const name of PLAN_SECTIONS) {
        const lines = sectionLines(details ?? '', name);
        if (lines === undefined) { problems.push(`no "${name}" section`); continue; }
        const said = lines.filter((l) => !PLACEHOLDER.test(l.replace(/\.$/, '')));
        if (said.some((l) => TEMPLATE_SLOT.test(l))) problems.push(`"${name}" still has a template slot (<...>) to fill`);
        else if (!said.length) problems.push(`"${name}" is empty or a placeholder`);
        else if (name === 'Prior art' && said.every((l) => NOTHING_READ.test(l.replace(/\.$/, '')))) problems.push('"Prior art" says nothing was read; name what you read and reuse it or say why not');
    }
    return problems;
}
