import type { LedgerRow } from '../ledger-core.ts';
import type { Args } from './args.ts';
import { clip } from './format.ts';

/** The digest window, both ends inclusive (YYYY-MM-DD). */
export interface Window { since: string; until: string }
/** What approvalsWindow reads from the run: the flags, the clock, and the usage-error exit. */
export interface WindowContext { arg: Args['arg']; has: Args['has']; die: (message: string) => never; today: () => string }
/** One grant in the digest, reported under the latest row that touched it. */
export interface Grant { id?: string; date?: string; text?: string; scope: unknown; refs: string[]; taggedBy?: string }
export interface UntaggedDecision { id?: string; date?: string; text?: string; repo?: string }
export interface Digest { standing: Grant[]; oneOff: Grant[]; untagged: UntaggedDecision[] }
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
    const out: Digest = { standing: [], oneOff: [], untagged: [] };
    const bucket: Record<string, Grant[]> = { standing: out.standing, 'one-off': out.oneOff };
    for (const list of events.values()) {
        const latest = list[list.length - 1].subject;
        if (!list.some((ev) => inWindow(ev.subject.date) || inWindow(ev.fields.date))) continue;
        bucket[String(lastSet(list, 'approval'))]?.push({ id: latest.id, date: latest.date, text: latest.text, scope: lastSet(list, 'scope'), refs: (lastSet(list, 'refs') || []) as string[], taggedBy: list.filter((ev) => ev.tag).pop()?.tag?.id });
    }
    for (const e of entries) {
        if (e.id && !e.annotates && e.kind === 'decision' && !e.pending && !e.closes && !events.has(e.id) && inWindow(e.date)) out.untagged.push({ id: e.id, date: e.date, text: e.text, repo: e.repo });
    }
    for (const list of Object.values(out) as { date?: string }[][]) list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return out;
}

export function approvalsText(g: Digest, { since, until }: Window, week: string, today: () => string): string {
    const refLine = (a: Grant): string => (a.refs.length ? a.refs.join(', ') : 'none');
    return [
        '---', 'type: review', 'status: draft', `week: ${week}`, `generated: ${today()}`, `since: ${since}`, `until: ${until}`, '---', '',
        `# Approvals review ${week}`, '',
        `Generated by \`journal.mjs approvals\` for approvals dated ${since} to ${until}. Tick keep, narrow or revoke for each standing approval, then update wherever a narrowed or revoked one is recorded (memory files, config, instructions).`, '',
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
        '## Untagged decisions', '',
        'Decision rows with no approval tag. If any was the user granting permission, classify it with `journal.mjs approve-tag <id> --approval standing|one-off`.', '',
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
