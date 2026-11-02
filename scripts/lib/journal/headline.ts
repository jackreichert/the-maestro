/** The most characters an item's headline may have (design section 5: "a headline of at most 80 characters, enforced by the writer"). Detail goes in a `log` row or the brief. */
export const HEADLINE_MAX = 80;

/** The refusal for a headline that is too long, or null. `command` names the verb so the message says where the detail goes instead. */
export function headlineProblem(text: string, command: string): string | null {
    const length = text.replace(/\s+/g, ' ').trim().length;
    return length <= HEADLINE_MAX ? null : `${command}: headline is ${length} characters; keep it to ${HEADLINE_MAX} or fewer. Shorten the text, and put the detail in \`journal.ts log <id> "<detail>"\` or the brief.`;
}
