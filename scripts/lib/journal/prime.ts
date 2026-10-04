import { RESUME_GH, VAULT_ROOT, TRACKER_KEY_PATTERN } from '../../local-config.ts';
import { BOX, classify, gateStatus } from '../boxes.ts';
import { approvalMap } from './approvals.ts';
import { activeStreams } from './board.ts';
import { clip } from './format.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import type { Args } from './args.ts';
import type { BoardContext, Groups } from './board.ts';

/** gh's view of a PR; the board gates read only `state`. */
export interface PrState { state: string; mergedAt?: string }
const isPrState = (j: unknown): j is PrState => typeof j === 'object' && j !== null && 'state' in j && typeof j.state === 'string';
/** A command run that reports instead of throwing: `ok` is false when it is missing or exits non-zero. */
export type TryRun = (cmd: string, args: string[]) => { ok: boolean; missing?: boolean; out: string; err: string };
/** What the pending-transitions check reads: the ledger and its fold. */
export interface PendingContext { readLedger: () => LedgerRow[]; fold: BoardContext['fold'] }
/** What the session-start view reads from the run. */
export interface PrimeContext extends PendingContext {
    groups: (includeArchived?: boolean) => Groups;
    today: () => string;
    project: string;
    tryRun: TryRun;
    ticketStatuses: (ids: string[]) => Map<string, { status?: string }> | null;
    arg: Args['arg'];
}
/** A done item whose tracker transition nobody recorded, one per key. */
export interface PendingRow { key: string; id?: string; text?: string; doneOn?: string }


/** gh's view of a PR as { state, mergedAt }, or null when gh is missing, fails or answers with something unreadable. */
export function ghPrState(ctx: PrimeContext, repo: string, number: number): PrState | null {
    const { tryRun } = ctx;
    const r = tryRun('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergedAt']);
    if (!r.ok) return null;
    try { const j: unknown = JSON.parse(r.out); return isPrState(j) ? j : null; } catch { return null; }
}

/** A ticket's status through the derived index; null when there is no tickets vault or no answer. */
export function ticketStatusOf(ctx: PrimeContext, id: string): string | null {
    const { arg, ticketStatuses } = ctx;
    if (!(arg('tickets-vault') || VAULT_ROOT)) return null;
    return ticketStatuses([id])?.get(id)?.status ?? null;
}

/**
 * Open blocked items that carry a gate, each with where the gate stands. Read-only: it reports, it never promotes
 * or closes an item. gh gates honour resume_gh (off means "unknown", not a gh call).
 */
export function gateReport(ctx: PrimeContext) {
    const { groups, today } = ctx;
    const lookups = { pr: (repo: string, n: number) => (RESUME_GH ? ghPrState(ctx, repo, n) : null), ticket: (id: string) => ticketStatusOf(ctx, id) };
    return groups().blocked.filter((i) => i.gate).map((i) => ({ item: i, ...gateStatus(i.gate, today(), lookups) }));
}

/**
 * The session-start view: at most 40 lines, however long the ledger is. Today's streams, then Needs Jack, paste blocks,
 * gated and in-flight items in that order. When it does not fit, each section gives up lines evenly and says how many it hid.
 * Reads only the ledger (no gh, no network), so it is safe to run from a hook.
 */
export const PRIME_MAX_LINES = 40;

export function primeLines(ctx: PrimeContext): string[] {
    const { groups, readLedger, today, project } = ctx;
    const g = groups();
    const approvals = approvalMap(readLedger());
    const asks = g.awaiting.filter((i) => classify(i, approvals.get(i.id ?? '')) !== BOX.PASTE);
    const paste = [...g.paste, ...g.awaiting.filter((i) => classify(i, approvals.get(i.id ?? '')) === BOX.PASTE)];
    const label = (i: LedgerItem): string => `${i.id} ${clip(i.text, 90)}${i.paste ? ` [block: ${clip(i.paste, 120)}]` : ''}${i.gate ? ` [gate: ${clip(i.gate, 80)}]` : ''}${i.stream ? ` (${clip(i.stream, 40)})` : ''}`;
    const sections = [
        { title: 'Needs Jack', items: asks },
        { title: 'Paste blocks for Jack', items: paste },
        { title: 'Blocked / gated', items: g.blocked },
        { title: 'In flight', items: g.inflight },
    ].filter((sec) => sec.items.length).map((sec) => ({ ...sec, lines: sec.items.map(label) }));
    const streams = activeStreams(g.inflight, g.blocked, g.awaiting, g.paste);
    const pending = pendingTransitions(ctx, defaultPendingSince());
    const head = [clip(`Board ${today()} · project ${project}`, 120), clip(`Today's streams: ${streams.length ? streams.join(', ') : 'none'}`, 200),
        ...(pending.length ? [clip(`Pending tracker transitions (${pending.length}): ${pending.map((r) => r.key).join(', ')}. \`journal.ts tickets --pending\``, 200)] : [])];
    const foot = g.deferred.length ? [`${g.deferred.length} deferred item(s) hidden. \`journal.ts status\` and \`triage\` have the rest.`] : ['`journal.ts status` has the rest.'];
    if (!sections.length) return [...head, '(nothing open)', ...foot];
    // Whatever the content, the cap holds: the budget below counts lines, and this guard backs it up.
    const capped = (lines: string[]): string[] => (lines.length <= PRIME_MAX_LINES ? lines : [...lines.slice(0, PRIME_MAX_LINES - foot.length), ...foot]);

    // Round-robin the line budget so a long section cannot starve the others; a trimmed section ends in "+N more".
    let budget = PRIME_MAX_LINES - head.length - foot.length - sections.length;
    const shown = sections.map(() => 0);
    for (let progressed = true; budget > 0 && progressed;) {
        progressed = false;
        sections.forEach((sec, k) => { if (budget > 0 && shown[k] < sec.lines.length) { shown[k]++; budget--; progressed = true; } });
    }
    const body = sections.flatMap((sec, k) => {
        const hidden = sec.lines.length - shown[k];
        const keep = hidden ? Math.max(0, shown[k] - 1) : shown[k];
        return [`${sec.title} (${sec.lines.length})`, ...sec.lines.slice(0, keep).map((l) => `  ${l}`), ...(hidden ? [`  … +${hidden} more`] : [])];
    });
    return capped([...head, ...body, ...foot]);
}

export const PENDING_WINDOW_DAYS = 14;

/** Distinct tracker keys (tracker_key_pattern) in the given texts. */
export const trackerKeys = (...texts: unknown[]): string[] => [...new Set(texts.flatMap((t) => String(t || '').match(new RegExp(TRACKER_KEY_PATTERN, 'g')) || []))];

/**
 * Done items finished on or after `since` that carry a tracker key (in the ticket field, the text, or the closing row)
 * whose transition nobody recorded. A transition is recorded by any ledger row with `transitioned: [KEY, ...]`
 * (`journal.ts log "moved FAKE-1 to In Staging" --transitioned FAKE-1`), at any date. One row per key: [{ key, id, text, doneOn }].
 */
export function pendingTransitions(ctx: PendingContext, since: string): PendingRow[] {
    const { readLedger, fold } = ctx;
    const entries = readLedger();
    const recorded = new Set(entries.flatMap((e) => e.transitioned || []));
    const rows: PendingRow[] = [];
    for (const i of fold(entries).items) {
        const doneOn = i.closedBy?.date || i.date;
        if (i.state !== 'done' || (doneOn !== undefined && doneOn < since)) continue;
        for (const key of trackerKeys(i.ticket, i.text, i.closedBy?.ticket, i.closedBy?.text)) {
            if (!recorded.has(key) && !rows.some((r) => r.key === key)) rows.push({ key, id: i.id, text: i.text, doneOn });
        }
    }
    return rows;
}

export const defaultPendingSince = (): string => new Date(Date.now() - PENDING_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
