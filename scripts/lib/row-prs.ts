/**
 * Link a ledger row to the pull request opened for it, so a merge can close the row.
 * The link is a `ref` row (`attaches` the item, `refs` `gh:pr:owner/repo#N`, `branch`); fold folds it into the item's `refs` and `branch`.
 */
import { fold, isOpen } from './ledger-core.ts';
import type { Store } from './journal/store.ts';

const ITEM_ID = /^[a-z0-9]{4,6}$/;
const BRANCH_ITEM = /(?:^|\/)MAESTRO-([a-z0-9]{4,6})(?=-|$)/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/;

export interface PrLink { repo: string; number: number }
export type LinkResult = 'linked' | 'already-linked' | 'not-open' | 'bad-id';

/** `gh:pr:owner/repo#N`, the form merge-sweep and the board read from a row's refs. */
export const prRef = (pr: PrLink): string => `gh:pr:${pr.repo}#${pr.number}`;

/** The owner/repo and number in the first GitHub pull request URL in `text`, or undefined. */
export function parsePrUrl(text: string): PrLink | undefined {
    const m = PR_URL.exec(text);
    return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : undefined;
}

/** The ledger id a branch name carries (`feat/MAESTRO-6tq3-close-rows` gives `6tq3`); a numeric ticket key like `MAESTRO-345` is not a ledger id. */
export function itemIdFromBranch(branch: string): string | undefined {
    const id = BRANCH_ITEM.exec(branch)?.[1];
    return id && /[a-z]/.test(id) ? id : undefined;
}

/** Which row the PR is for: `--item`, then MAESTRO_ITEM, then a ledger id in the branch name. Only a well-formed id is returned. */
export function itemFor(flag: string | undefined, env: string | undefined, branch: string): string | undefined {
    const id = [flag, env].find((v) => v && v.trim())?.trim() ?? itemIdFromBranch(branch);
    return id && ITEM_ID.test(id) ? id : undefined;
}

/** Append the PR link to an open item. Idempotent: linking the same PR twice writes one row. Returns why nothing was written, if so. */
export function linkRowToPr(store: Pick<Store, 'readLedger' | 'append' | 'newId'>, itemId: string, pr: PrLink, branch: string, clock: { now: () => string; today: () => string }): LinkResult {
    if (!ITEM_ID.test(itemId)) return 'bad-id';
    const entries = store.readLedger();
    const item = fold(entries, null).items.find((i) => i.id === itemId);
    if (!item || !isOpen(item)) return 'not-open';
    const ref = prRef(pr);
    if ((item.refs ?? []).includes(ref)) return 'already-linked';
    store.append({
        id: store.newId(entries),
        ts: clock.now(),
        date: clock.today(),
        kind: 'ref',
        attaches: itemId,
        text: `PR ${pr.repo}#${pr.number} opened for ${itemId}`,
        refs: [ref],
        ...(branch ? { branch } : {}),
        model: 'n/a',
        used: ['tool:pr-open.ts'],
    });
    return 'linked';
}
