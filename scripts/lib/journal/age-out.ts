import { isOpen, isPendingDecision, isQueued } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import { gateStatus, parseGate } from '../boxes.ts';
import { closeItem } from './close.ts';
import type { CloseContext } from './close.ts';

/**
 * Age-out: awaiting and queued rows that nothing closes by hand. A row whose gate or ticket has cleared, or whose branch has
 * landed, is proposed for closing with the evidence beside it. Gate and ticket evidence is machine-checked, so `age-out --apply`
 * (and the unattended `maintain`) closes on it; a branch that merged or vanished is only a flag, because an ask can outlive its
 * branch. Pure: the caller supplies the lookups, so nothing here touches gh, git or the vault.
 */

/** An open ask: a question, or a decision still pending. */
export const isAwaiting = (i: LedgerRow & { closedBy?: LedgerRow | null }): boolean => isOpen(i) && (i.kind === 'question' || isPendingDecision(i));

/** The rows age-out looks at: awaiting asks and queued to-dos. In-flight work is closed by whoever did it, never by a sweep. */
export const isAgeable = (i: LedgerRow & { closedBy?: LedgerRow | null }): boolean => isAwaiting(i) || isQueued(i);

export type BranchState = 'merged' | 'gone' | 'live';

/** What the evidence checks read. Each returns null when it cannot tell, and a null never proposes anything. */
export interface AgeOutLookups {
    pr: (repo: string, number: number) => { state?: string; mergedAt?: string } | null;
    ticket: (id: string) => string | null;
    branch: (repo: string | undefined, name: string) => BranchState | null;
}

export interface Proposal {
    id: string;
    text: string;
    /** `gate`, `ticket` or `branch`. */
    basis: 'gate' | 'ticket' | 'branch';
    evidence: string;
    /** True when the evidence is a machine-checked fact (a cleared gate, a closed ticket); false for a flag a person should confirm. */
    autoClose: boolean;
}

const BRANCH_IN_TEXT = /\b(?:feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert|hotfix|release)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/;

/** The branch a row names: its `branch` field, else the first conventional branch name in its text. */
export function namedBranch(i: LedgerRow): string | undefined {
    if (typeof i.branch === 'string' && i.branch) return i.branch;
    return BRANCH_IN_TEXT.exec(String(i.text ?? ''))?.[0];
}

/** One proposal per open awaiting or queued row whose gate or ticket has cleared, or whose named branch has merged or gone. The first piece of evidence wins. */
export function proposeCloses(items: LedgerItem[], today: string, lookups: AgeOutLookups, hidden: ReadonlySet<string> = new Set()): Proposal[] {
    const out: Proposal[] = [];
    for (const i of items) {
        if (!i.id || hidden.has(i.id) || !isAgeable(i)) continue;
        const text = String(i.text ?? '');
        const make = (basis: Proposal['basis'], evidence: string, autoClose: boolean): void => { out.push({ id: i.id as string, text, basis, evidence, autoClose }); };
        const gate = typeof i.gate === 'string' && parseGate(i.gate) ? gateStatus(i.gate, today, lookups) : null;
        if (gate?.state === 'cleared') { make('gate', `gate cleared: ${gate.detail}`, true); continue; }
        const ticket = typeof i.ticket === 'string' && i.ticket ? i.ticket : undefined;
        if (ticket && lookups.ticket(ticket) === 'closed') { make('ticket', `ticket ${ticket} is closed`, true); continue; }
        const branch = namedBranch(i);
        const state = branch ? lookups.branch(typeof i.repo === 'string' ? i.repo : undefined, branch) : null;
        if (branch && (state === 'merged' || state === 'gone')) make('branch', `branch ${branch} is ${state === 'merged' ? 'merged' : 'deleted'}`, false);
    }
    return out;
}

/** The lines `triage` and `age-out` print: one per proposal with its evidence, then how to act on them. Empty when there are none. */
export function proposalLines(proposals: Proposal[]): string[] {
    if (!proposals.length) return [];
    const auto = proposals.filter((p) => p.autoClose).length;
    return [
        `Proposed close (${proposals.length}; ${auto} verified, closed by \`age-out --apply\`):`,
        ...proposals.map((p) => `  ${p.id}  ${p.autoClose ? 'verified' : 'confirm  '}  ${p.evidence}  ${p.text.slice(0, 80)}`),
    ];
}

/** Closes each verified proposal with a `resolved` row that carries its evidence. Returns the ids closed; a row `closeItem` refuses stays open. */
export function applyProposals(ctx: CloseContext, proposals: Proposal[], extras?: () => object): string[] {
    const closed: string[] = [];
    for (const p of proposals.filter((x) => x.autoClose)) {
        const r = closeItem(ctx, { kind: 'resolved', needle: p.id, note: `aged out: ${p.evidence}`, extras, skipIfClosed: true });
        if (r.kind === 'closed') closed.push(p.id);
    }
    return closed;
}
