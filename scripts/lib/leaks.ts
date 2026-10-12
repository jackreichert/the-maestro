/**
 * Avoidable-spend report: each bucket replays what the transcripts did under one change and prices the difference.
 * Pure functions over the turns `scanFile` returns, so no transcript text is ever in reach: a turn carries token counts,
 * tool names, a read-only flag, file basenames and result sizes only. Prices come from `model_prices`; none are built in.
 * A figure is a counterfactual on the same tokens, not a billed amount: it ignores any difference in how many tokens
 * another setup would have needed or how good its work would have been.
 */
import type { ModelPrice } from '../local-config.ts';
import type { Turn } from '../token-metrics.ts';
import { kindsOf, dollars, priceKey } from './pricing.ts';
import { family } from './model-family.ts';
import { isExpiryRewrite } from './expiry.ts';

/** One transcript's turns: the orchestrator's, or a subagent's with the agent type from its `.meta.json`. */
export interface Transcripts { orch: Turn[][]; subs: { type: string; turns: Turn[] }[] }
export type Prices = Record<string, ModelPrice>;
/** One ranked bucket: dollars avoidable, what it was, one line per notable item, and the change that avoids it. */
export interface Leak { bucket: string; usd: number; detail: string[]; fix: string }

/** The price row for a model family, or undefined when none applies (an `other` model with no `other` row). */
const rowFor = (prices: Prices, fam: string): ModelPrice | undefined => prices[priceKey(fam)];
/** Dollars for a turn's tokens at family `fam`'s prices (or `at`'s when given); 0 when that family has no price row. */
const turnUsd = (prices: Prices, t: Turn, at: string = family(t.model)): number => {
    const p = rowFor(prices, at);
    return p ? dollars(kindsOf(t), p).total : 0;
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const usd = (n: number): string => `$${n.toFixed(2)}`;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The most expensive items first, as detail lines: `label: note, $x`. */
function topLines(items: Map<string, { n: number; usd: number }>, unit: string, limit = 5): string[] {
    return [...items].sort((a, b) => b[1].usd - a[1].usd).slice(0, limit).map(([k, v]) => `${k}: ${plural(v.n, unit)}, ${usd(v.usd)}`);
}

/**
 * Subagent runs that only read (every tool call they made was a read-only one; a run with no tool calls is left out), priced
 * as they ran and again with the same tokens at Haiku. The saving is the difference, grouped by agent type.
 */
export function readOnlySubagents(t: Transcripts, prices: Prices): Leak | null {
    const haiku = prices.haiku;
    if (!haiku) return null;
    const byType = new Map<string, { n: number; usd: number }>();
    for (const sub of t.subs) {
        const calls = sub.turns.flatMap((x) => x.tools || []);
        if (!calls.length || !calls.every((c) => c.readOnly)) continue;
        const saving = sum(sub.turns.filter((x) => family(x.model) !== 'haiku').map((x) => turnUsd(prices, x) - turnUsd(prices, x, 'haiku')));
        if (saving <= 0) continue;
        const cur = byType.get(sub.type) || { n: 0, usd: 0 };
        byType.set(sub.type, { n: cur.n + 1, usd: cur.usd + saving });
    }
    const total = sum([...byType.values()].map((v) => v.usd));
    if (total <= 0) return null;
    return {
        bucket: 'Read-only subagents on a dearer model, repriced at Haiku',
        usd: total,
        detail: topLines(byType, 'run'),
        fix: 'set `model: haiku` in these agent definitions, or pass model haiku when dispatching them',
    };
}

/** A 1h cache entry outlives a gap up to this long (seconds); past it the context is rewritten whatever the TTL. */
const CACHE_1H_SEC = 3600;

/**
 * Subagent cache writes replayed with a 1h TTL instead of 5m. Every 5m write would cost the 1h write price instead, and a cache-expiry
 * rewrite after a gap of at most an hour would have been a cache read. The figure is the net: rewrites avoided minus the extra paid for
 * every write; a TTL that costs more than it saves is not reported. Writes usage already marks as 1h are unchanged.
 */
export function subagentCacheTtl(t: Transcripts, prices: Prices): Leak | null {
    let extra = 0;
    let avoided = 0;
    let rewrites = 0;
    for (const x of t.subs.flatMap((s) => s.turns)) {
        const p = rowFor(prices, family(x.model));
        if (!p) continue;
        const w5 = kindsOf(x).w5;
        extra += (w5 * (p.cache_write_1h - p.cache_write_5m)) / 1e6;
        if (isExpiryRewrite(x) && (x.gapSec as number) <= CACHE_1H_SEC) { avoided += (w5 * (p.cache_write_5m - p.cache_read)) / 1e6; rewrites += 1; }
    }
    const net = avoided - extra;
    if (net <= 0) return null;
    return {
        bucket: 'Subagent prompt cache on a 1h TTL instead of 5m',
        usd: net,
        detail: [`${plural(rewrites, 'expiry rewrite')} within the hour avoided, ${usd(avoided)}; every 5m write at the 1h price costs ${usd(extra)} more`],
        fix: 'set `subagentPromptCacheTtl` to `1h` in settings (decision and trade-off in cost/budget.md)',
    };
}

/** Every bucket with something to report, most dollars first. */
export function leaks(t: Transcripts, prices: Prices): Leak[] {
    return [readOnlySubagents(t, prices), subagentCacheTtl(t, prices)].filter((l): l is Leak => l !== null).sort((a, b) => b.usd - a.usd);
}

/** The ranked report as text; says so when nothing avoidable was found. */
export function formatLeaks(list: Leak[]): string {
    const head = 'Avoidable spend, priced from model_prices (counterfactuals on the same tokens, not billed amounts)';
    if (!list.length) return `${head}\nnothing found`;
    return [head, ...list.flatMap((l, i) => [`${i + 1}. ${usd(l.usd)}  ${l.bucket}`, ...l.detail.map((d) => `     ${d}`), `   fix: ${l.fix}`])].join('\n');
}
