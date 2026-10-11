/**
 * The pull requests an open ledger row names, and which of those rows name a PR that is already merged. Pure over rows and two injected lookups
 * (`ownerOf` maps a bare repo name to `owner/name`, `stateOf` asks GitHub); queue-report.ts supplies the real ones. Read-only: nothing here closes a row.
 *
 * A row names a PR as `owner/repo#N`, a github.com `.../pull/N` URL, or `#N` / `PR N` next to the row's own `repo` field.
 */
export interface PrRow { id?: string; text?: string; repo?: string; refs?: string[]; date?: string }
export interface PrRef { repo: string; number: number }
export interface MergedRow { id: string; text: string; date?: string; prs: { ref: PrRef; state: string }[]; allMerged: boolean }

export function prRefs(row: PrRow, ownerOf: (repo: string) => string | undefined): PrRef[] {
    const hay = [row.text ?? '', ...(row.refs ?? [])].join('\n');
    const found = new Map<string, PrRef>();
    const add = (repo: string | undefined, n: string): void => { if (repo) found.set(`${repo}#${n}`, { repo, number: Number(n) }); };
    for (const m of hay.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) add(m[1], m[2] as string);
    for (const m of hay.matchAll(/(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)/g)) add(m[1], m[2] as string);
    if (row.repo) {
        const full = row.repo.includes('/') ? row.repo : ownerOf(row.repo);
        for (const m of hay.matchAll(/(?<![\w/.-])(?:#|PR\s*#?)(\d+)\b/gi)) add(full, m[1] as string);
    }
    return [...found.values()];
}

export function mergedRows(rows: readonly PrRow[], ownerOf: (repo: string) => string | undefined, stateOf: (ref: PrRef) => string | undefined): MergedRow[] {
    const cache = new Map<string, string | undefined>();
    const state = (r: PrRef): string | undefined => { const k = `${r.repo}#${r.number}`; if (!cache.has(k)) cache.set(k, stateOf(r)); return cache.get(k); };
    const out: MergedRow[] = [];
    for (const row of rows) {
        const prs = prRefs(row, ownerOf).map((ref) => ({ ref, state: state(ref) ?? 'UNKNOWN' }));
        if (prs.some((p) => p.state === 'MERGED')) out.push({ id: row.id ?? '', text: row.text ?? '', date: row.date, prs, allMerged: prs.every((p) => p.state === 'MERGED') });
    }
    return out;
}
