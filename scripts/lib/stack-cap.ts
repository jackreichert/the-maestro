/**
 * Stack depth and age cap: find stacked PRs (a PR whose base is another open PR's head branch, in the same repo) and
 * flag any stack deeper than `stack_max_depth` or older than `stack_max_age_days`. Pure: prs-snapshot.ts hands in the PR
 * list and the limits. The numbers are a judgement, not a measured optimum; they are settings so they can move.
 *
 * A stack's depth is the length of its longest chain from the bottom PR. Its age runs from its oldest PR's creation.
 * A PR with no stacked PR above or below it is not a stack. Twin PRs (one head branch, two bases) are separate roots; a
 * PR stacked on that head belongs to both stacks.
 */
export interface StackPr { key: string; repo: string; number: number; url: string; headRefName: string; baseRefName: string; createdAt?: string }
export interface Stack {
    repo: string;
    /** Bottom PR first, along the longest chain. */
    chain: StackPr[];
    depth: number;
    /** Days from the oldest PR in the stack to now; null when no PR carries a creation time (an older snapshot). */
    ageDays: number | null;
    overDepth: boolean;
    overAge: boolean;
}
export interface StackLimits { maxDepth: number; maxAgeDays: number }

const DAY = 86_400_000;

/** Every stack in the list with two or more PRs, over the limits or not. */
export function findStacks(prs: StackPr[], now: Date, limits: StackLimits): Stack[] {
    const children = (p: StackPr): StackPr[] => prs.filter((c) => c.repo === p.repo && c.baseRefName === p.headRefName && c.key !== p.key);
    const hasParent = (p: StackPr): boolean => prs.some((o) => o.repo === p.repo && o.headRefName === p.baseRefName && o.key !== p.key);
    const out: Stack[] = [];
    for (const root of prs.filter((p) => !hasParent(p) && children(p).length)) {
        const members = new Map<string, StackPr>();
        const longest = (p: StackPr, seen: Set<string>): StackPr[] => {
            members.set(p.key, p);
            const next = children(p).filter((c) => !seen.has(c.key));
            const tails = next.map((c) => longest(c, new Set([...seen, c.key])));
            return [p, ...(tails.sort((a, b) => b.length - a.length)[0] ?? [])];
        };
        const chain = longest(root, new Set([root.key]));
        const created = [...members.values()].map((m) => Date.parse(m.createdAt ?? '')).filter(Number.isFinite);
        const ageDays = created.length ? Math.max(0, (now.getTime() - Math.min(...created)) / DAY) : null;
        out.push({ repo: root.repo, chain, depth: chain.length, ageDays, overDepth: chain.length > limits.maxDepth, overAge: ageDays !== null && ageDays > limits.maxAgeDays });
    }
    return out;
}

/** Lines for the PR board: one per stack over a limit, saying what to do; a single "none" line when all are within it. */
export function stackLines(prs: StackPr[], now: Date, limits: StackLimits): string[] {
    const over = findStacks(prs, now, limits).filter((s) => s.overDepth || s.overAge);
    if (!over.length) return [`Stacks over the cap (${limits.maxDepth} deep, ${limits.maxAgeDays} days): none`];
    return [
        `Stacks over the cap (${limits.maxDepth} deep, ${limits.maxAgeDays} days): ${over.length}`,
        ...over.map((s) => {
            const why = [s.overDepth ? `${s.depth} deep` : '', s.overAge ? `${Math.floor(s.ageDays ?? 0)} days old` : ''].filter(Boolean).join(', ');
            return `  ${s.repo}: ${why}: ${s.chain.map((p) => `#${p.number}`).join(' <- ')}. Stop adding to the top; drive ${s.chain[0].key} to merge: ${s.chain[0].url}`;
        }),
    ];
}
