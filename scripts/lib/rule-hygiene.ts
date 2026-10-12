/** Pure helpers for rule-hygiene.ts: read a memory rule's `enforced-by` tag and cross-reference an audit's repeat violations. */

export const ENFORCERS = ['hook', 'script', 'check', 'none'] as const;
export type Enforcer = (typeof ENFORCERS)[number];

export interface RuleFile { name: string; text: string }
export interface RuleStatus { name: string; enforcedBy: Enforcer | null; detail: string; problem: 'missing' | 'invalid' | null }

/** The frontmatter block of a memory file, or an empty string when it has none. */
function frontmatter(text: string): string {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    return m ? m[1] : '';
}

/** `enforced-by: <hook|script|check|none>[: detail]` at the top level of the frontmatter or under `metadata:`. */
export function readEnforcedBy(file: RuleFile): RuleStatus {
    const line = /^[ \t]*enforced-by:[ \t]*(.*)$/m.exec(frontmatter(file.text));
    if (!line) return { name: file.name, enforcedBy: null, detail: '', problem: 'missing' };
    const value = line[1].trim().replace(/^["']|["']$/g, '');
    const [kind, ...rest] = value.split(/[:\s]+/);
    const detail = value.slice(kind.length).replace(/^[:\s]+/, '');
    if (!(ENFORCERS as readonly string[]).includes(kind)) return { name: file.name, enforcedBy: null, detail: value, problem: 'invalid' };
    if (kind === 'script' && rest.length === 0) return { name: file.name, enforcedBy: 'script', detail: '', problem: 'invalid' };
    return { name: file.name, enforcedBy: kind as Enforcer, detail, problem: null };
}

export interface Repeat { rule: string; rows: number; dates: string[] }

/** Memory names cited in the audit's repeated-instruction table, with how many table rows cite each. A name counts only when it is a known rule. */
export function repeatViolations(audit: string, known: Set<string>): Repeat[] {
    const found = new Map<string, Repeat>();
    for (const row of audit.split('\n')) {
        if (!row.startsWith('|') || /^\|[\s|:-]+\|?$/.test(row)) continue;
        const cells = row.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length < 4) continue;
        const dates = cells[1].match(/\d{2}-\d{2}/g) ?? [];
        for (const token of new Set(cells[2].match(/`([a-z0-9-]+)`/g)?.map((t) => t.slice(1, -1)) ?? [])) {
            if (!known.has(token)) continue;
            const r = found.get(token) ?? { rule: token, rows: 0, dates: [] };
            r.rows += 1;
            r.dates.push(...dates);
            found.set(token, r);
        }
    }
    return [...found.values()].sort((a, b) => b.rows - a.rows || a.rule.localeCompare(b.rule));
}
