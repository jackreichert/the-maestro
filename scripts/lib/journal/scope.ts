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

/** The rules a window is bound by, and how many other windows' rules it must not treat as binding. */
export interface RulesInForce { here: LedgerRow[]; elsewhere: number }

/**
 * The rules that carry an explicit scope, split for `window`: its own window-scoped rules and every global one are binding here, other
 * windows' window-scoped rules are only counted. A row with no scope reads as global (`bindsHere`) but is not listed: it predates scopes,
 * and listing every old decision would bury the rules given on purpose. A pending decision is a question, not a rule.
 */
export function rulesInForce(rows: LedgerRow[], window: string): RulesInForce {
    const scoped = rows.filter((r) => r.kind !== undefined && SCOPED_KINDS.has(r.kind) && !r.pending && isRuleScope(r.ruleScope));
    const here = scoped.filter((r) => bindsHere(r, window));
    return { here, elsewhere: scoped.length - here.length };
}

const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain lines for `prime` and `status`: each binding rule (newest last, at most `max`, the rest counted), then one FYI line for other windows' rules. Empty when there is nothing to say. */
export function ruleLines(rows: LedgerRow[], window: string, max = 5): string[] {
    const { here, elsewhere } = rulesInForce(rows, window);
    const shown = here.slice(-max);
    return [
        ...(here.length > shown.length ? [`Rules in force: +${here.length - shown.length} older, \`journal.ts query\` has them`] : []),
        ...shown.map((r) => `Rule ${r.id ?? '?'} (${r.ruleScope === 'window' ? 'this window' : 'global'}): ${clipText(String(r.text ?? ''), 160)}`),
        ...(elsewhere ? [`FYI: ${elsewhere} ${elsewhere === 1 ? 'rule' : 'rules'} scoped to other windows, not binding here.`] : []),
    ];
}

/** The one footer line: how many rules bind this window, and a note of other windows' rules. Empty when there are none of either. */
export function ruleFooter(rows: LedgerRow[], window: string): string {
    const { here, elsewhere } = rulesInForce(rows, window);
    if (!here.length && !elsewhere) return '';
    const own = here.filter((r) => r.ruleScope === 'window').length;
    return `**Rules:** ${here.length} binding here (${own} this window, ${here.length - own} global)${elsewhere ? `; ${elsewhere} ${elsewhere === 1 ? 'rule' : 'rules'} scoped to other windows (FYI)` : ''}`;
}
