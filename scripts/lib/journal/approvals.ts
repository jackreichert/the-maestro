import type { LedgerRow } from '../ledger-core.ts';
import type { Args } from './args.ts';
import { clip } from './format.ts';

/** The digest window, both ends inclusive (YYYY-MM-DD). */
export interface Window { since: string; until: string }
/** What approvalsWindow reads from the run: the flags, the clock, and the usage-error exit. */
export interface WindowContext { arg: Args['arg']; has: Args['has']; die: (message: string) => never; today: () => string }
/** One grant in the digest, reported under the latest row that touched it. */
export interface Grant { id?: string; date?: string; text?: string; scope: unknown; refs: string[]; taggedBy?: string; reversal?: boolean }
export interface UntaggedDecision { id?: string; date?: string; text?: string; repo?: string }
export interface Digest { standing: Grant[]; oneOff: Grant[]; untagged: UntaggedDecision[]; reversals: Grant[] }

/**
 * Management 3.0 delegation levels, low to high. A proposal suggests the next level only, never a jump.
 * tell, sell, consult, agree, advise, inquire, delegate.
 */
// tell, sell, consult, agree, advise, inquire, delegate
export const DELEGATION_LEVELS = ['tell', 'sell', 'consult', 'agree', 'advise', 'inquire', 'delegate'] as const;
export type DelegationLevel = (typeof DELEGATION_LEVELS)[number];

/** One-off approvals with no reversal required before an area is proposed. */
export const PROPOSAL_THRESHOLD = 3;

/**
 * Hard limits. Fixed at tell and never proposed, whatever the approval counts.
 * Area names in the input — not loaded from rule files.
 */
export const HARD_LIMIT_AREAS = ['protected branches', 'attribution', 'secrets', 'frozen tracker labels'] as const;

/** A decision area and its current level. Hard-limit names are fixed at tell even if a caller says otherwise. */
export interface DecisionArea { name: string; level: DelegationLevel }
/** One approval row that counts toward a proposal. `id` is the id already on the row. */
export interface ApprovalEvidence { id: string; area: string; kind: 'one-off' | 'reversal'; date?: string }
/** A suggestion to move one area to the next level, citing the one-off approval ids that qualified it. */
export interface DelegationProposal { area: string; from: DelegationLevel; to: DelegationLevel; evidence: string[] }
/** Inclusive bounds. `now` is injected; the function does not read the clock. */
export interface ProposalBounds { since: string; now: string }
/** A row that grants or tags a grant: the row it is about, the fields it sets, and the tag row when it is one. */
interface GrantEvent { subject: LedgerRow; fields: LedgerRow; tag?: LedgerRow }

export const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 8601 week label (YYYY-Www) for a YYYY-MM-DD date. */
export function isoWeek(d: string): string {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));   // the Thursday of this week decides the year
    const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7)).padStart(2, '0')}`;
}

/** A real calendar date: YYYY-MM-DD that reads back unchanged, so 2026-02-30 is rejected. */
export const isDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const shiftDay = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The digest window as { since, until }, both inclusive. `until` is --until, else today. `since` is
 * --since, else `--days N` (default 7) ending on `until`: exactly N calendar days, so weekly runs do not overlap.
 */
export function approvalsWindow(ctx: WindowContext): Window {
    const { arg, has, die, today } = ctx;
    if (has('until') && !arg('until')) die('--until needs a value: YYYY-MM-DD.');
    const until = arg('until') ?? today();
    if (!isDate(until)) die('--until must be YYYY-MM-DD.');
    const since = arg('since');
    if (since) {
        if (!isDate(since)) die('--since must be YYYY-MM-DD.');
        if (since > until) die(`--since (${since}) is after --until (${until}).`);
        return { since, until };
    }
    const days = arg('days', '7');
    if (!/^[1-9]\d*$/.test(days)) die('--days must be a whole number of at least 1.');
    return { since: shiftDay(until, 1 - Number(days)), until };
}

/**
 * Approvals in the window, grouped, one entry per grant. A grant is a row that carries `approval`
 * itself, is pointed at by an `approval-tag` row, or closes a row with `--approval`; a closing row and
 * the row it closes are the same grant. The events of a grant merge field by field in ledger order: the
 * latest event that sets a field wins it, `scope` and `refs` carry over until replaced, and the entry
 * is reported under the latest event's row. A grant is in the window when any of its rows or tags is.
 * Untagged: `decision` rows that no approval touches.
 * A row with `reversal: true` is a reversal of its scope. It blocks a delegation proposal and is not evidence for one.
 */
export function collectApprovals(entries: LedgerRow[], { since, until }: Window): Digest {
    const byId = new Map<string, LedgerRow>();
    for (const e of entries) if (e.id) byId.set(e.id, e);
    const grantOf = (row: LedgerRow): string | undefined => row.closes || row.id;
    const events = new Map<string | undefined, GrantEvent[]>();
    const add = (key: string | undefined, event: GrantEvent) => events.set(key, [...(events.get(key) || []), event]);
    for (const e of entries) {
        if (!e.id || e.annotates) continue;
        if (e.kind === 'approval-tag') {
            const target = e.approves ? byId.get(e.approves) : undefined;
            if (target) add(grantOf(target), { subject: target, fields: e, tag: e });
        } else if (e.approval) add(grantOf(e), { subject: e, fields: e });
    }
    const inWindow = (d: unknown): boolean => String(d || '') >= since && String(d || '') <= until;
    const lastSet = (list: GrantEvent[], field: string): unknown => list.map((ev) => ev.fields[field]).filter((v) => (Array.isArray(v) ? v.length : v)).pop();
    const out: Digest = { standing: [], oneOff: [], untagged: [], reversals: [] };
    const bucket = new Map<string, Grant[]>([['standing', out.standing], ['one-off', out.oneOff]]);
    for (const list of events.values()) {
        const latest = list[list.length - 1].subject;
        if (!list.some((ev) => inWindow(ev.subject.date) || inWindow(ev.fields.date))) continue;
        const reversal = lastSet(list, 'reversal') === true;
        bucket.get(String(lastSet(list, 'approval')))?.push({
            id: latest.id, date: latest.date, text: latest.text, scope: lastSet(list, 'scope'),
            refs: (lastSet(list, 'refs') || []) as string[], taggedBy: list.filter((ev) => ev.tag).pop()?.tag?.id,
            ...(reversal ? { reversal } : {}),
        });
    }
    for (const e of entries) {
        if (e.id && !e.annotates && e.kind === 'decision' && !e.pending && !e.closes && !events.has(e.id) && inWindow(e.date)) out.untagged.push({ id: e.id, date: e.date, text: e.text, repo: e.repo });
        if (e.id && !e.annotates && e.reversal === true && inWindow(e.date)) out.reversals.push({ id: e.id, date: e.date, text: e.text, scope: e.scope, refs: (Array.isArray(e.refs) ? e.refs : []) as string[], reversal: true });
    }
    for (const grant of [...out.standing, ...out.oneOff]) {
        if (grant.reversal && grant.id && !out.reversals.some((row) => row.id === grant.id)) out.reversals.push(grant);
    }
    const byDate = (a: { date?: string }, b: { date?: string }): number => String(a.date).localeCompare(String(b.date));
    out.standing.sort(byDate); out.oneOff.sort(byDate); out.untagged.sort(byDate); out.reversals.sort(byDate);
    return out;
}

const isLevel = (value: string): value is DelegationLevel => (DELEGATION_LEVELS as readonly string[]).includes(value);

/** Hard-limit names match after trim, ignoring case, so a differently cased row cannot be proposed. */
export function isHardLimit(area: string): boolean {
    const name = area.trim().toLowerCase();
    return HARD_LIMIT_AREAS.some((limit) => limit.toLowerCase() === name);
}

/** The next delegation level, or undefined at `delegate`. Never skips a level. */
export function nextDelegationLevel(level: DelegationLevel): DelegationLevel | undefined {
    const i = DELEGATION_LEVELS.indexOf(level);
    return i >= 0 && i < DELEGATION_LEVELS.length - 1 ? DELEGATION_LEVELS[i + 1] : undefined;
}

const areaName = (scope: unknown): string => (typeof scope === 'string' ? scope.trim() : '');

const inProposalBounds = (date: string | undefined, bounds: ProposalBounds): boolean => {
    const d = date ?? '';
    return d >= bounds.since && d <= bounds.now;
};

/**
 * Areas that can move up one delegation level. An area qualifies with `PROPOSAL_THRESHOLD` or more
 * one-off approvals and zero reversals inside `bounds` (inclusive). Evidence ids are copied from the
 * rows; none are invented. Hard limits stay at tell and are never proposed. `bounds.now` is injected.
 */
export function proposeDelegations(
    areas: readonly DecisionArea[],
    evidence: readonly ApprovalEvidence[],
    bounds: ProposalBounds,
): DelegationProposal[] {
    const levelOf = new Map<string, DelegationLevel>();
    for (const area of areas) {
        const name = area.name.trim();
        if (!name || levelOf.has(name) || isHardLimit(name) || !isLevel(area.level)) continue;
        levelOf.set(name, area.level);
    }
    const oneOffIds = new Map<string, string[]>();
    const reversed = new Set<string>();
    const ordered = [...evidence].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
    for (const row of ordered) {
        const area = row.area.trim();
        if (!area || !row.id || !inProposalBounds(row.date, bounds)) continue;
        if (row.kind === 'reversal') { reversed.add(area); continue; }
        if (row.kind !== 'one-off' || isHardLimit(area)) continue;
        const ids = oneOffIds.get(area) ?? [];
        if (!ids.includes(row.id)) ids.push(row.id);
        oneOffIds.set(area, ids);
    }
    const proposals: DelegationProposal[] = [];
    for (const [area, from] of levelOf) {
        if (reversed.has(area) || isHardLimit(area)) continue;
        const ids = oneOffIds.get(area) ?? [];
        if (ids.length < PROPOSAL_THRESHOLD) continue;
        const to = nextDelegationLevel(from);
        if (!to) continue;
        proposals.push({ area, from, to, evidence: ids });
    }
    proposals.sort((a, b) => a.area.localeCompare(b.area));
    return proposals;
}

function evidenceFrom(g: Digest): ApprovalEvidence[] {
    const out: ApprovalEvidence[] = [];
    const seen = new Set<string>();
    const add = (row: Grant, kind: ApprovalEvidence['kind']) => {
        const area = areaName(row.scope);
        if (!area || !row.id || seen.has(`${kind}\0${row.id}`)) return;
        seen.add(`${kind}\0${row.id}`);
        out.push({ id: row.id, area, kind, date: row.date });
    };
    for (const row of g.oneOff) add(row, row.reversal ? 'reversal' : 'one-off');
    for (const row of g.standing) if (row.reversal) add(row, 'reversal');
    for (const row of g.reversals ?? []) add(row, 'reversal');
    return out;
}

/** Caller-supplied levels win. Scopes on one-off rows default to tell so the digest can propose one step without a stored level. */
function areasFor(g: Digest, given: readonly DecisionArea[]): DecisionArea[] {
    const out: DecisionArea[] = [];
    const seen = new Set<string>();
    for (const area of given) {
        const name = area.name.trim();
        if (!name || seen.has(name) || isHardLimit(name) || !isLevel(area.level)) continue;
        seen.add(name);
        out.push({ name, level: area.level });
    }
    for (const row of evidenceFrom(g)) {
        if (row.kind !== 'one-off' || seen.has(row.area) || isHardLimit(row.area)) continue;
        seen.add(row.area);
        out.push({ name: row.area, level: 'tell' });
    }
    return out;
}

function proposalEnd(window: Window, today: () => string): string {
    const now = today();
    return window.until < now ? window.until : now;
}

function delegationSection(g: Digest, window: Window, today: () => string, areas: readonly DecisionArea[]): string[] {
    const proposals = proposeDelegations(areasFor(g, areas), evidenceFrom(g), { since: window.since, now: proposalEnd(window, today) });
    const lines = proposals.map((p) => `- \`${p.area}\` ${p.from} -> ${p.to} (evidence: ${p.evidence.map((id) => `\`${id}\``).join(', ')})`);
    return [
        '## Delegation proposals', '',
        'Hard limits stay at tell and are never proposed.', '',
        ...HARD_LIMIT_AREAS.map((name) => `- \`${name}\` fixed at tell`), '',
        `Areas with ${PROPOSAL_THRESHOLD} or more one-off approvals and no reversal in the window. The suggestion is the next level only.`, '',
        'Levels, low to high: tell, sell, consult, agree, advise, inquire, delegate.', '',
        ...(lines.length ? lines : ['_none_']), '',
    ];
}

export function approvalsText(g: Digest, { since, until }: Window, week: string, today: () => string, areas: readonly DecisionArea[] = []): string {
    const refLine = (a: Grant): string => (a.refs.length ? a.refs.join(', ') : 'none');
    const window = { since, until };
    return [
        '---', 'type: review', 'status: draft', `week: ${week}`, `generated: ${today()}`, `since: ${since}`, `until: ${until}`, '---', '',
        `# Approvals review ${week}`, '',
        `Generated by \`journal.ts approvals\` for approvals dated ${since} to ${until}. Tick keep, narrow or revoke for each standing approval, then update wherever a narrowed or revoked one is recorded (memory files, config, instructions).`, '',
        '## Standing approvals', '',
        ...(g.standing.length ? g.standing.flatMap((a) => [
            `### ${a.date} \`${a.id}\``, '',
            clip(a.text, 400), '',
            `- Scope: ${a.scope || 'not recorded'}`, `- Ref: ${refLine(a)}`, `- Source row: \`${a.id}\`${a.taggedBy ? ` (tagged by \`${a.taggedBy}\`)` : ''}`,
            '- [ ] keep  - [ ] narrow  - [ ] revoke', '',
        ]) : ['_none_', '']),
        '## One-off approvals', '',
        'For awareness. No action needed.', '',
        ...(g.oneOff.length ? g.oneOff.map((a) => `- ${a.date} \`${a.id}\` ${clip(a.text, 200)} (ref: ${refLine(a)})`) : ['_none_']), '',
        ...delegationSection(g, window, today, areas),
        '## Untagged decisions', '',
        'Decision rows with no approval tag. If any was the user granting permission, classify it with `journal.ts approve-tag <id> --approval standing|one-off`.', '',
        ...(g.untagged.length ? g.untagged.map((a) => `- ${a.date} \`${a.id}\` ${clip(a.text, 200)}`) : ['_none_']), '',
    ].join('\n');
}

/** Effective approval per row id: a row's own, its closing row's, and `approval-tag` rows; the latest one set wins. */
export function approvalMap(entries: LedgerRow[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of entries) {
        if (e.kind === 'approval-tag' && e.approves && e.approval) out.set(e.approves, e.approval);
        else if (e.id && !e.annotates && e.approval) out.set(e.closes || e.id, e.approval);
    }
    return out;
}
