/**
 * Canonical names for the `model` and `used` tags a ledger row carries, as data tables plus the pure functions that
 * apply them. One definition for the writer (store.ts, journal.ts) and every reader (the fold), so a model or tool
 * is counted under one name. The ledger is append-only: history is normalised when read, never rewritten.
 *
 * A registry `models` section (streams.json) extends or overrides the model table; the table here is the floor.
 * Dependency-free so ledger-core.ts can import it.
 */

/** Canonical model id -> the other spellings seen in the wild. Matching is case-insensitive and trims whitespace. */
export const MODEL_TABLE: Record<string, { aliases: string[] }> = {
    'claude-opus-5-5': { aliases: ['Claude Opus 5.5', 'Opus 5.5', 'opus-5-5', 'opus-5.5', 'claude-opus-5.5', 'opus'] },
    'claude-sonnet-5-5': { aliases: ['Claude Sonnet 5.5', 'Sonnet 5.5', 'sonnet-5-5', 'sonnet-5.5', 'claude-sonnet-5.5', 'sonnet'] },
    'claude-haiku-5-5': { aliases: ['Claude Haiku 5.5', 'Haiku 5.5', 'haiku-5-5', 'haiku-5.5', 'claude-haiku-5.5', 'haiku'] },
    'claude-sonnet-5': { aliases: ['Claude Sonnet 5', 'Sonnet 5', 'sonnet-5'] },
    'claude-haiku-4-5': { aliases: ['Claude Haiku 4.5', 'Haiku 4.5', 'haiku-4-5', 'haiku-4.5', 'claude-haiku-4-5-20251001'] },
    'grok-4.7': { aliases: ['Grok 4.7', 'grok-4-7', 'copilot-grok-4.7'] },
};

/** Values that mean "no model": they pass through untouched and never warn. */
export const MODEL_SENTINELS: ReadonlySet<string> = new Set(['unrecorded', 'n/a', 'unmeasured']);

/** Tool tags that name one tool two ways: lowercased alias -> canonical name (no `tool:` prefix). */
export const TOOL_ALIASES: Record<string, string> = {
    'jira-mcp': 'atlassian-mcp',
};

/** Script extensions stripped from a tool name, so `journal.mjs` and `journal.ts` are the same tool. */
export const TOOL_EXTENSIONS: readonly string[] = ['.mjs', '.cjs', '.js', '.ts', '.sh', '.py'];

/** Canonical model id for a table spelling, or null. Case-insensitive. */
export function tableModel(name: unknown, table: Record<string, { aliases?: unknown[] }> = MODEL_TABLE): string | null {
    if (typeof name !== 'string') return null;
    const k = name.trim().toLowerCase();
    for (const [canon, meta] of Object.entries(table)) {
        if (canon.toLowerCase() === k || (meta?.aliases || []).some((a) => String(a).toLowerCase() === k)) return canon;
    }
    return null;
}

/** The script extension `name` ends with, when something is left of it. */
const stripped = (name: string): string | undefined => TOOL_EXTENSIONS.find((e) => name.endsWith(e) && name.length > e.length);

/** One `used` mark in canonical form. Only `tool:` marks change: extension stripped, lowercased, aliased. Anything else passes through. */
export function normaliseMark(mark: string): string {
    const m = /^tool:(.+)$/i.exec(mark.trim());
    if (!m) return mark;
    let name = m[1].trim().toLowerCase();
    for (let ext = stripped(name); ext; ext = stripped(name)) name = name.slice(0, -ext.length);
    return `tool:${TOOL_ALIASES[name] ?? name}`;
}

/** A `used` value (a list, a single string, or anything a hand edit left there) with every tool mark canonical and duplicates removed. Non-string values pass through. */
export function normaliseUsed(used: unknown): unknown {
    if (typeof used === 'string') return normaliseMark(used);
    if (!Array.isArray(used)) return used;
    return [...new Set(used.map((x) => (typeof x === 'string' ? normaliseMark(x) : x)))];
}
