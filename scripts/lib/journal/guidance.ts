import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip } from './format.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';

/** The note the roll writes for the next session, beside the ledger's other generated files. */
export const GUIDANCE_FILE = 'GUIDANCE.md';
/** Never fewer than this many hours in flight before an item counts as stalled. */
export const STALL_FLOOR_HOURS = 24;
/** An item is stalled when it has run this many times longer than the median finished item. */
export const STALL_MEDIAN_FACTOR = 3;
/** How far back finished items set the "usual" duration. */
export const HISTORY_DAYS = 14;
/** Cap on the note: the three sections, one line each, plus a header. */
export const GUIDANCE_MAX_LINES = 4;

const HOUR = 36e5;
const label = (i: LedgerItem): string => `${i.id} ${clip(i.text, 60)}`;

/** The size of a `--tokens` mark: "42k", "1.2M" or "5000" read as a count; "unmeasured", "n/a" and the like as 0. */
export function tokenCount(raw: unknown): number {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?(?![A-Za-z0-9])/.exec(String(raw ?? ''));
    if (!m) return 0;
    const scale = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
    return Math.round(Number(m[1]) * scale);
}

const startedAt = (i: LedgerItem): number => Date.parse(i.stateTs ?? i.ts ?? '');
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fmtHours = (h: number): string => (h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);
const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Hours an in-flight item must have run to count as stalled: the floor, or a multiple of the median finished item, whichever is longer. */
export function stallThresholdHours(items: LedgerItem[], nowMs: number): number {
    const since = nowMs - HISTORY_DAYS * 24 * HOUR;
    const spans = items.filter((i) => i.state === 'done' && i.closedBy?.ts && Date.parse(i.closedBy.ts) >= since)
        .map((i) => (Date.parse(i.closedBy?.ts ?? '') - Date.parse(i.ts ?? '')) / HOUR).filter((h) => Number.isFinite(h) && h >= 0);
    return Math.max(STALL_FLOOR_HOURS, STALL_MEDIAN_FACTOR * median(spans));
}

/**
 * The guidance for the next session, derived from ledger data alone: what stalled (in flight far longer than finished items
 * usually take, or an open item that needed rework), what cost most (the biggest `--tokens` item and stream among items started or finished today
 * and everything still open; a count recorded on `done` wins over the one on the opening row), and what to do first (the first blocked item, else the first in flight, in board order).
 * Empty when there is nothing to say; never a model call.
 */
export function guidanceLines(items: LedgerItem[], entries: LedgerRow[], inflight: LedgerItem[], blocked: LedgerItem[], d: string, nowMs: number): string[] {
    const limit = stallThresholdHours(items, nowMs);
    const reworked = new Set(entries.filter((e) => e.kind === 'rework' && e.reworks).map((e) => e.reworks));
    const stalled = [...inflight, ...blocked].map((i) => ({ i, age: (nowMs - startedAt(i)) / HOUR })).filter(({ i, age }) => reworked.has(i.id) || (inflight.includes(i) && age > limit));
    stalled.sort((a, b) => b.age - a.age);
    const worst = stalled[0];
    const stalledLine = worst
        ? `Stalled (${stalled.length}): ${label(worst.i)}, ${reworked.has(worst.i.id) ? 'reworked' : `${fmtHours(worst.age)} in flight (usual under ${fmtHours(limit)})`}${stalled.length > 1 ? ` +${stalled.length - 1} more` : ''}`
        : null;

    const open = new Set([...inflight, ...blocked]);
    const spent = (i: LedgerItem): number => tokenCount(i.closedBy?.tokens) || tokenCount(i.tokens);
    const costed = items.filter((i) => i.date === d || i.closedBy?.date === d || open.has(i)).map((i) => ({ i, n: spent(i) })).filter((c) => c.n > 0);
    const byStream = new Map<string, number>();
    for (const { i, n } of costed) byStream.set(i.stream ?? 'none', (byStream.get(i.stream ?? 'none') ?? 0) + n);
    const topItem = costed.sort((a, b) => b.n - a.n)[0];
    const topStream = [...byStream].sort((a, b) => b[1] - a[1])[0];
    const costLine = topItem && topStream ? `Cost most: ${label(topItem.i)} (${fmtTokens(topItem.n)} tokens); stream ${topStream[0]} ${fmtTokens(topStream[1])} in all` : null;

    const first = blocked[0] ?? inflight[0];
    const firstLine = first ? `Do first: ${label(first)}${blocked[0] ? ' (blocked: clear the block)' : ''}` : null;

    const lines = [stalledLine, costLine, firstLine].filter((l): l is string => l !== null);
    return lines.length ? [`Guidance from the ${d} roll:`, ...lines.map((l) => `  ${l}`)] : [];
}

/** Write the note beside the ledger; with nothing to say it still writes a one-line note, so a stale one never lingers. */
export function writeGuidance(dir: string, lines: string[], d: string): string {
    const path = join(dir, GUIDANCE_FILE);
    writeFileSync(path, `${lines.length ? lines.join('\n') : `Guidance from the ${d} roll:\n  Nothing stalled, nothing costly, nothing open.`}\n`);
    return path;
}

/** The saved note's lines for `prime`, or none when there is no note. A note older than `maxAgeDays` is skipped: stale advice misleads. */
export function readGuidance(dir: string, today: string, maxAgeDays = 3): string[] {
    const path = join(dir, GUIDANCE_FILE);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(0, GUIDANCE_MAX_LINES + 1);
    const date = /(\d{4}-\d{2}-\d{2})/.exec(lines[0] ?? '')?.[1];
    if (!date || (Date.parse(today) - Date.parse(date)) / (24 * HOUR) > maxAgeDays) return [];
    return lines;
}
