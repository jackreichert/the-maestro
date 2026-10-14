import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip } from './format.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import type { Priority } from '../status-page/priorities.ts';

/** The note the roll writes for the next session, beside the ledger's other generated files. */
export const GUIDANCE_FILE = 'GUIDANCE.md';
/** Never fewer than this many hours in flight before an item counts as stalled. */
export const STALL_FLOOR_HOURS = 24;
/** An item is stalled when it has run this many times longer than the median finished item. */
export const STALL_MEDIAN_FACTOR = 3;
/** How far back finished items set the "usual" duration. */
export const HISTORY_DAYS = 14;
/** Cap on the note: the four sections, one line each, plus a header. */
export const GUIDANCE_MAX_LINES = 5;

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

/** Items parked on purpose, or waiting on the user: the next session cannot act on them. */
const PARKED = /\b(on hold|hold for now|parked|paused|frozen|deferred|waiting (on|for) (jack|him|a decision)|awaiting (jack|a decision)|needs[- ]you)\b/i;

/** What `guidanceLines` may also know: asks waiting on the user (their ids are never "do first"), where each gated item's gate stands (a gate not reported as cleared counts as waiting) and today's priorities (preferred when any item matches). */
export interface GuidanceContext { awaiting?: LedgerItem[]; priorities?: Priority[]; gates?: Map<string, 'cleared' | 'waiting' | 'unknown'> }

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `needle` appears in `hay` as whole words, case-insensitively: "auth" is not in "author". */
const hasWord = (hay: string, needle: string): boolean => needle.trim().length > 0 && new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(needle.trim())}(?![\\p{L}\\p{N}_])`, 'iu').test(hay);

/** Whether an item answers a priority: the priority names the item's id, shares its stream, or the item's text and the priority's contain one another as whole words. */
const matchesPriority = (i: LedgerItem, ps: Priority[]): boolean => ps.some((p) => hasWord(p.text, String(i.id)) || (!!p.stream && !!i.stream && p.stream.toLowerCase() === i.stream.toLowerCase()) || (p.text.length > 3 && hasWord(i.text ?? '', p.text)));

/** Hours an in-flight item must have run to count as stalled: the floor, or a multiple of the median finished item, whichever is longer. */
export function stallThresholdHours(items: LedgerItem[], nowMs: number): number {
    const since = nowMs - HISTORY_DAYS * 24 * HOUR;
    const spans = items.filter((i) => i.state === 'done' && i.closedBy?.ts && Date.parse(i.closedBy.ts) >= since)
        .map((i) => (Date.parse(i.closedBy?.ts ?? '') - Date.parse(i.ts ?? '')) / HOUR).filter((h) => Number.isFinite(h) && h >= 0);
    return Math.max(STALL_FLOOR_HOURS, STALL_MEDIAN_FACTOR * median(spans));
}

/**
 * The guidance for the next session, derived from ledger data alone: what stalled (in flight far longer than finished items
 * usually take), what was reworked today (any item with a `rework` row dated today, finished or open), what cost most (the biggest `--tokens` item and stream among items started or finished today
 * and everything still open; a count recorded on `done` wins over the one on the opening row), and what to do first (an item whose gate has cleared, else one that answers one of today's priorities, else the first blocked item, else the first in flight, in board order; never an item whose gate is still waiting, parked on purpose or waiting on the user).
 * Empty when there is nothing to say; never a model call.
 */
export function guidanceLines(items: LedgerItem[], entries: LedgerRow[], inflight: LedgerItem[], blocked: LedgerItem[], d: string, nowMs: number, ctx: GuidanceContext = {}): string[] {
    const limit = stallThresholdHours(items, nowMs);
    const stalled = inflight.map((i) => ({ i, age: (nowMs - startedAt(i)) / HOUR })).filter(({ age }) => age > limit);
    stalled.sort((a, b) => b.age - a.age);
    const worst = stalled[0];
    const stalledLine = worst
        ? `Stalled (${stalled.length}): ${label(worst.i)}, ${fmtHours(worst.age)} in flight (usual under ${fmtHours(limit)})${stalled.length > 1 ? ` +${stalled.length - 1} more` : ''}`
        : null;

    // A rework row is found after use, so its target is usually finished: any item, open or done, counts.
    const reworkedIds = [...new Set(entries.filter((e) => e.kind === 'rework' && e.reworks && e.date === d).map((e) => String(e.reworks)))];
    const firstReworked = reworkedIds[0];
    const reworkLine = firstReworked
        ? `Reworked today (${reworkedIds.length}): ${(() => { const t = items.find((i) => i.id === firstReworked); return t ? label(t) : firstReworked; })()}${reworkedIds.length > 1 ? ` +${reworkedIds.length - 1} more` : ''}`
        : null;

    const open = new Set([...inflight, ...blocked]);
    const spent = (i: LedgerItem): number => tokenCount(i.closedBy?.tokens) || tokenCount(i.tokens);
    const costed = items.filter((i) => i.date === d || i.closedBy?.date === d || open.has(i)).map((i) => ({ i, n: spent(i) })).filter((c) => c.n > 0);
    const byStream = new Map<string, number>();
    for (const { i, n } of costed) byStream.set(i.stream ?? 'none', (byStream.get(i.stream ?? 'none') ?? 0) + n);
    const topItem = costed.sort((a, b) => b.n - a.n)[0];
    const topStream = [...byStream].sort((a, b) => b[1] - a[1])[0];
    const costLine = topItem && topStream ? `Cost most: ${label(topItem.i)} (${fmtTokens(topItem.n)} tokens); stream ${topStream[0]} ${fmtTokens(topStream[1])} in all` : null;

    const waiting = new Set((ctx.awaiting ?? []).map((i) => i.id));
    // The structured gate decides when the item has one; the text pattern is only the fallback for items with none.
    const cleared = (i: LedgerItem): boolean => !!i.gate && ctx.gates?.get(String(i.id)) === 'cleared';
    const actionable = (i: LedgerItem): boolean => !waiting.has(i.id) && (i.gate ? cleared(i) : !PARKED.test(i.text ?? ''));
    const pool = [...blocked, ...inflight].filter(actionable);
    const ps = ctx.priorities ?? [];
    const first = pool.find(cleared) ?? (ps.length ? pool.find((i) => matchesPriority(i, ps)) : undefined) ?? pool[0];
    const firstLine = first ? `Do first: ${label(first)}${blocked.includes(first) ? ' (blocked: clear the block)' : ''}` : null;

    const lines = [stalledLine, reworkLine, costLine, firstLine].filter((l): l is string => l !== null);
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
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(0, GUIDANCE_MAX_LINES);
    const date = /(\d{4}-\d{2}-\d{2})/.exec(lines[0] ?? '')?.[1];
    if (!date || (Date.parse(today) - Date.parse(date)) / (24 * HOUR) > maxAgeDays) return [];
    return lines;
}
