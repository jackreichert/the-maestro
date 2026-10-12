import type { LedgerRow } from '../ledger-core.ts';

/** Who a rule binds: only the window that wrote it, or every window on the ledger. */
export type RuleScope = 'window' | 'global';
export const RULE_SCOPES: readonly RuleScope[] = ['window', 'global'];
/** The row kinds that can carry a scope: a rule (a decision row) and a note. */
export const SCOPED_KINDS: ReadonlySet<string> = new Set(['decision', 'note']);

export const isRuleScope = (v: unknown): v is RuleScope => v === 'window' || v === 'global';

/** The scope a `--scope` flag asks for, or why it cannot be used. A row with no scope reads as global (see `bindsHere`). */
export function parseRuleScope(value: string | null, kind: string): { scope: RuleScope } | { error: string } {
    if (!isRuleScope(value)) return { error: `--scope must be ${RULE_SCOPES.join(' or ')} (got "${value ?? ''}"). With --approval it is the approval's own scope text instead.` };
    if (!SCOPED_KINDS.has(kind)) return { error: `--scope ${RULE_SCOPES.join('|')} only goes on: ${[...SCOPED_KINDS].join(', ')} (not ${kind}).` };
    return { scope: value };
}

/** True when `row` binds the window `window`: a row scoped to one window binds only that window, and every other row (global, or written before scopes existed) binds all. */
export const bindsHere = (row: LedgerRow, window: string): boolean => row.ruleScope !== 'window' || row.window === window;
