/**
 * The pull requests an open ledger row names, and which of those rows name a PR that is already merged. Pure over rows and two injected lookups
 * (`ownerOf` maps a bare repo name to `owner/name`, `stateOf` asks GitHub); queue-report.ts supplies the real ones. Read-only: nothing here closes a row.
 *
 * A row names a PR as `owner/repo#N`, a github.com `.../pull/N` URL, `#N` / `PR N` next to the row's own `repo` field, or `<name> #N` where `<name>` (or `<repoPrefix><name>`, when a prefix is configured) is a repo `ownerOf` knows from a real checkout (`strict`, so an ordinary word never becomes a repo).
 */
export interface PrRow { id?: string; text?: string; repo?: string; refs?: string[]; date?: string }
export interface PrRef { repo: string; number: number }
export interface MergedRow { id: string; text: string; date?: string; prs: { ref: PrRef; state: string }[]; allMerged: boolean }

export type OwnerOf = (repo: string, strict?: boolean) => string | undefined;

/** `repoPrefix` is a repo-name prefix a team puts on its repos (the `repo_prefix` setting), so `tool #5` can mean `<prefix>tool`. Empty by default. */
export function prRefs(row: PrRow, ownerOf: OwnerOf, repoPrefix = ''): PrRef[] {
    const hay = [row.text ?? '', ...(row.refs ?? [])].join('\n');
    const found = new Map<string, PrRef>();
    const add = (repo: string | undefined, n: string): void => { if (repo) found.set(`${repo}#${n}`, { repo, number: Number(n) }); };
    for (const m of hay.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) add(m[1], m[2] as string);
    for (const m of hay.matchAll(/(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)/g)) add(m[1], m[2] as string);
    for (const m of hay.matchAll(/(?<![\w/.-])([A-Za-z][\w.-]*) #(\d+)\b/g)) {
        const word = m[1] as string;
        add(ownerOf(word, true) ?? (repoPrefix ? ownerOf(`${repoPrefix}${word}`, true) : undefined), m[2] as string);
    }
    if (row.repo) {
        const full = row.repo.includes('/') ? row.repo : ownerOf(row.repo);
        for (const m of hay.matchAll(/(?<![\w/.-])(?:#|PR\s*#?)(\d+)\b/gi)) add(full, m[1] as string);
    }
    return [...found.values()];
}

export function mergedRows(rows: readonly PrRow[], ownerOf: OwnerOf, stateOf: (ref: PrRef) => string | undefined, repoPrefix = ''): MergedRow[] {
    const cache = new Map<string, string | undefined>();
    const state = (r: PrRef): string | undefined => { const k = `${r.repo}#${r.number}`; if (!cache.has(k)) cache.set(k, stateOf(r)); return cache.get(k); };
    const out: MergedRow[] = [];
    for (const row of rows) {
        const prs = prRefs(row, ownerOf, repoPrefix).map((ref) => ({ ref, state: state(ref) ?? 'UNKNOWN' }));
        if (prs.some((p) => p.state === 'MERGED')) out.push({ id: row.id ?? '', text: row.text ?? '', date: row.date, prs, allMerged: prs.every((p) => p.state === 'MERGED') });
    }
    return out;
}
