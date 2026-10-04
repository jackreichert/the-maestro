import { itemText } from './format.ts';
import { TICKET_ID } from './retro.ts';
import type { LedgerItem, LedgerRow, Registry } from '../ledger-core.ts';
import type { BoardContext } from './board.ts';

/** What backfill reads from the run: the ledger, its fold and the stream registry. */
export interface BackfillContext { readLedger: () => LedgerRow[]; fold: BoardContext['fold']; loadRegistry: () => Registry | null }
/** Stream counts for one key. */
type Counts = Map<string | undefined, number>;
/** How already-tagged items are filed, by repo, ticket id and work session. */
export interface Evidence { byRepo: Map<string, Counts>; byTicket: Map<string, Counts>; bySession: Map<number, Counts>; sessionOf: Map<string | undefined, number> }
export interface Keyword { stream: string; re: RegExp }
/** One reason to file an item under a stream, worth `points`. */
export interface Vote { rule: string; stream: string | undefined; points: number }
export interface Proposal { stream: string | null; confidence: string | null; rules: string[]; tie?: boolean; conflict?: boolean }

export const CONF = ['low', 'medium', 'high'];
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * Evidence about how already-tagged items are filed: stream counts per repo, per ticket id, and per
 * work session (a run of rows with no gap over 30 minutes; the ledger has no session field).
 */
export function backfillEvidence(items: LedgerItem[]): Evidence {
    const tagged = items.filter((i) => i.stream);
    const tally = <K>(map: Map<K, Counts>, key: K | undefined, stream: string | undefined): void => { if (!key) return; const m: Counts = map.get(key) || new Map(); m.set(stream, (m.get(stream) || 0) + 1); map.set(key, m); };
    const byRepo = new Map<string, Counts>();
    const byTicket = new Map<string, Counts>();
    for (const i of tagged) {
        tally(byRepo, i.repo, i.stream);
        for (const t of new Set([i.ticket, ...(itemText(i).match(TICKET_ID) || [])].filter(Boolean))) tally(byTicket, t, i.stream);
    }
    const sorted = [...items].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const sessionOf = new Map<string | undefined, number>();
    let n = 0;
    let last: number | null = null;
    for (const i of sorted) {
        const t = Date.parse(i.ts ?? '');
        if (last !== null && t - last > SESSION_GAP_MS) n++;
        sessionOf.set(i.id, n);
        last = t;
    }
    const bySession = new Map<number, Counts>();
    for (const i of tagged) tally(bySession, sessionOf.get(i.id), i.stream);
    return { byRepo, byTicket, bySession, sessionOf };
}

/** The top stream of a tally with its share and total, or null when empty or tied. */
export function dominant(m: Counts | undefined): { stream: string | undefined; n: number; total: number; share: number } | null {
    if (!m) return null;
    const rows = [...m].sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((a, [, c]) => a + c, 0);
    if (rows.length > 1 && rows[0][1] === rows[1][1]) return null;
    return { stream: rows[0][0], n: rows[0][1], total, share: rows[0][1] / total };
}

/** Streams a backfill may propose: registered and not archived, plus every stream the ledger already uses. */
export function candidateStreams(ctx: Pick<BackfillContext, 'loadRegistry'>, items: LedgerItem[], archived: Iterable<string | undefined>): Set<string> {
    const { loadRegistry } = ctx;
    const reg = loadRegistry();
    const names = new Set([...Object.entries(reg?.streams || {}).filter(([, m]) => m?.status !== 'archived').map(([k]) => k), ...items.flatMap((i) => (i.stream ? [i.stream] : []))]);
    for (const a of archived) if (a !== undefined) names.delete(a);
    return names;
}

/** Votes for one untagged item: [{ rule, stream, points }]. Points: ticket 4 (unanimous, 2+ items) or 1, keyword 2, repo 2 (90%+ of 5+ items) or 1, session neighbours 1. 4+ is high, 2-3 medium, 1 low. */
export function votesFor(item: LedgerItem, ev: Evidence, keywords: Keyword[]): Vote[] {
    const votes: Vote[] = [];
    const tickets = new Set([item.ticket, ...(itemText(item).match(TICKET_ID) || [])].filter((t): t is string => Boolean(t)));
    let best: Vote | null = null;
    for (const t of tickets) {
        const d = dominant(ev.byTicket.get(t));
        if (!d) continue;
        const points = d.share === 1 && d.n >= 2 ? 4 : 1;
        if (!best || points > best.points) best = { rule: 'ticket', stream: d.stream, points };
    }
    if (best) votes.push(best);

    const text = itemText(item).toLowerCase();
    const hits = new Set(keywords.filter((k) => k.re.test(text)).map((k) => k.stream));
    if (hits.size === 1) votes.push({ rule: 'keyword', stream: [...hits][0], points: 2 });

    const r = dominant(ev.byRepo.get(item.repo ?? ''));
    if (r) votes.push({ rule: 'repo', stream: r.stream, points: r.share >= 0.9 && r.total >= 5 ? 2 : 1 });

    const s = dominant(ev.bySession.get(ev.sessionOf.get(item.id) ?? -1));
    if (s && s.total >= 2 && s.share >= 0.6) votes.push({ rule: 'session', stream: s.stream, points: 1 });
    return votes;
}

/** { stream, confidence, rules } for an untagged item, or null when nothing votes. Disagreement caps it at low. */
export function proposalFor(item: LedgerItem, ev: Evidence, keywords: Keyword[], allowed: Set<string>): Proposal | null {
    const votes = votesFor(item, ev, keywords).filter((v) => allowed.has(v.stream ?? ''));
    if (!votes.length) return null;
    const score = new Map<string | undefined, number>();
    for (const v of votes) score.set(v.stream, (score.get(v.stream) || 0) + v.points);
    const ranked = [...score].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return { stream: null, confidence: 'low', rules: votes.map((v) => v.rule), tie: true };
    const [stream, points] = ranked[0];
    const conflict = ranked.length > 1;
    const confidence = conflict ? 'low' : points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low';
    return { stream: stream ?? null, confidence, rules: votes.filter((v) => v.stream === stream).map((v) => v.rule), conflict };
}

export function backfillProposals(ctx: BackfillContext) {
    const { readLedger, fold, loadRegistry } = ctx;
    const folded = fold(readLedger());
    const untagged = folded.items.filter((i) => !i.stream && !folded.hidden.has(i.id ?? ''));
    const ev = backfillEvidence(folded.items);
    const allowed = candidateStreams(ctx, folded.items, folded.archivedStreams);
    const reg = loadRegistry();
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keywords = Object.entries(reg?.streams || {}).filter(([canon]) => allowed.has(canon)).flatMap(([canon, meta]) =>
        [canon, ...(meta?.aliases || [])].map(String).filter((w) => w.length >= 3)
            .map((w) => ({ stream: canon, re: new RegExp(`(?<![\\w-])${esc(w.toLowerCase())}(?![\\w-])`) })));
    const proposals = untagged.map((item) => ({ item, ...(proposalFor(item, ev, keywords, allowed) || { stream: null, confidence: null, rules: [] }) }));
    return { proposals, untagged: untagged.length };
}
