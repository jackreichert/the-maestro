/**
 * The model-free half of roll, as `journal.ts maintain` runs it (the roll-maintenance event type calls it): which past days
 * still owe an archive, and the one JSON line the command ends with so a caller reads a result instead of scraping prose.
 */

/** How many past days one run looks back over. Older unarchived days are left for a deliberate `roll --date`. */
export const MAINTAIN_LOOKBACK_DAYS = 7;

/** The `n` days before `today` (YYYY-MM-DD), newest first. Empty for a malformed `today`. */
export function daysBefore(today: string, n: number = MAINTAIN_LOOKBACK_DAYS): string[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
    const start = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isFinite(start)) return [];
    return Array.from({ length: n }, (_, i) => new Date(start - (i + 1) * 86_400_000).toISOString().slice(0, 10));
}

/** What a maintenance run did. `ok` is false when any step failed; `problems` says which, one line each. */
export interface MaintainResult {
    ok: boolean;
    archivedDays: string[];
    /** Null when the sweep did not run (refused, skipped or failed to start). */
    sweep: { removed: number; pruned: number; kept: number; skipped: number; failed: number } | null;
    problems: string[];
}

export const MAINTAIN_PREFIX = 'maintain-result ';

/** The one line a run ends with. */
export const maintainLine = (r: MaintainResult): string => `${MAINTAIN_PREFIX}${JSON.stringify(r)}`;

/** The result in a run's stdout, or null when it printed none (it crashed before the end). The last such line wins. */
export function parseMaintainLine(stdout: string): MaintainResult | null {
    const line = stdout.split('\n').reverse().find((l) => l.startsWith(MAINTAIN_PREFIX));
    if (!line) return null;
    try {
        const r = JSON.parse(line.slice(MAINTAIN_PREFIX.length)) as Partial<MaintainResult>;
        if (typeof r.ok !== 'boolean' || !Array.isArray(r.archivedDays) || !Array.isArray(r.problems)) return null;
        return r as MaintainResult;
    } catch { return null; }
}
