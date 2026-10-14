/**
 * The daily cost experiment: which metric yesterday's numbers say to work on. Pure, so the choice is tested on fixtures and the
 * CLI (scripts/cost-experiment.ts) only reads the table and prints it.
 */
import type { Comparison, Prices } from '../token-metrics.ts';

/** The mix metrics, as named in token-metrics.ts, and the order a tie goes in. */
const MIX_METRICS = ['Opus share (read)', 'Haiku share (read)'];
const TOP_REGRESSIONS = 3;

/** Cost habits already approved by the user (cost/loop.md): a proposal that applies one may start as `running`; anything else waits as `proposed` for a decision. */
export const APPROVED_HABITS: Record<string, string> = {
  'standing-brief': 'the standing brief block in every dispatch',
  'foreground-waits': 'blocking waits inside agents instead of background watchers',
  'capped-reports': 'agent reports capped at about 20 lines with detail in a file',
  'lean-tool-output': 'fields=, gh --json --jq and counts instead of default tool payloads',
  'haiku-routing': 'Haiku for verifiable gathering and read-only playbooks',
  'session-hygiene': 'roll the session at the configured turn or read limit',
};

export interface Pick {
  basis: 'regression' | 'mix' | 'none';
  metric: string | null;
  today: number | null; median7: number | null; vs7: number | null; limit: number | null; dir: string | null;
  /** For a mix pick, how far past its target the metric is as a fraction of the target (negative: inside it, by that margin). */
  gap: number | null;
  reason: string;
  /** Every regressed metric, worst first (at most three), so the proposal can mention what it is not picking. */
  regressions: { name: string; vs7: number }[];
}

/**
 * Regressions rank by estimated dollars. A metric that has a dollar value is priced and compared on one scale: the Est. $ metrics
 * directly, and Cache read and Output at the sonnet row of `model_prices` (the reference tier; the table holds no per-day mix for
 * a Comparison to use). Anything priced needs a move of at least $0.50, and a 7-day median of at least $0.50, to rank. The per-unit
 * token metrics (Read/turn, Read/prompt, Read/subagent, Avg report, Sub growth), shares, ratios and counts have no dollar value on
 * their own (Cache read and the Est. $ metrics already carry their volume), so they rank only after every priced regression, by
 * their absolute move in units of a named material move. Turns and Wakes get floors sized to their real medians (hundreds);
 * Wakes/prompt covers the same signal. Without prices, Cache read and Output fall back to unit floors worth about $0.50.
 * A median under its floor cannot rank at all: against a base that small a percentage is noise (Expiry rewrites 37 -> 589 read
 * as +1492%). The percentage only breaks a tie.
 */
const DOLLAR_FLOOR = 0.5;
const PRICED_TOKENS: Record<string, 'cache_read' | 'output'> = { 'Cache read': 'cache_read', Output: 'output' };
const MATERIAL_BY_FMT: Record<string, number> = { n: 1000, pct: 0.05, ratio: 0.25, usd: DOLLAR_FLOOR };
const MATERIAL_BY_NAME: Record<string, number> = { Turns: 100, Wakes: 50, 'Max turns/compact': 20, 'Expiry rewrites': 50, 'Cache read': 2.5e6, Output: 50000 };
const materiality = (c: Comparison): number => MATERIAL_BY_NAME[c.name] ?? MATERIAL_BY_FMT[c.fmt] ?? MATERIAL_BY_FMT.n as number;

/** Dollars per token for a priced token metric, or null when it has no dollar value (or no prices are set). */
function dollarsPerToken(c: Comparison, prices: Prices): number | null {
  const field = PRICED_TOKENS[c.name];
  const row = prices?.sonnet;
  return field && row ? row[field] / 1e6 : null;
}

/** The ranking key: tier 0 is priced (score in dollars), tier 1 is unpriced (score in material moves). Null when it cannot rank. */
export function impact(c: Comparison, prices: Prices = null): { tier: 0 | 1; score: number } | null {
  if (!Number.isFinite(c.today) || !Number.isFinite(c.median7)) return null;
  const scale = c.fmt === 'usd' ? 1 : dollarsPerToken(c, prices);
  const tier = scale === null ? 1 : 0;
  const unit = scale ?? 1 / materiality(c);
  const floor = tier === 0 ? DOLLAR_FLOOR : 1;
  const moved = Math.abs(c.today - c.median7) * unit;
  return c.median7 * unit < floor || moved < floor ? null : { tier, score: moved };
}

const num = (n: number): number | null => (Number.isFinite(n) ? n : null);

/** How far past its target a mix metric is, as a fraction of the target; positive is a miss. NaN when it has no number or no limit. */
export function mixGap(c: Comparison): number {
  if (!Number.isFinite(c.today) || !Number.isFinite(c.limit) || !c.limit) return NaN;
  return (c.dir === 'min' ? c.limit - c.today : c.today - c.limit) / c.limit;
}

function describe(basis: Pick['basis'], c: Comparison | null, gap: number | null, reason: string, regressions: Pick['regressions']): Pick {
  return { basis, metric: c?.name ?? null, today: c ? num(c.today) : null, median7: c ? num(c.median7) : null, vs7: c ? num(c.vs7) : null, limit: c ? num(c.limit) : null, dir: c?.dir ?? null, gap, reason, regressions };
}

/**
 * The metric to work on: the regression with the largest dollar impact (see `impact`; either direction a regression can go; moves under the floor, or from a median under it, do not count; the percentage only breaks a tie);
 * when nothing regressed, the mix metric furthest from its target (a miss beats a pass, the smallest margin beats a larger one); with
 * no number for either, `none`. Ties go to the earlier metric in the list.
 */
export function selectTarget(list: Comparison[], prices: Prices = null): Pick {
  const ranked = list.flatMap((c) => { const k = c.regression && Number.isFinite(c.vs7) ? impact(c, prices) : null; return k ? [{ c, ...k }] : []; })
    .sort((a, b) => a.tier - b.tier || b.score - a.score || Math.abs(b.c.vs7) - Math.abs(a.c.vs7));
  const regressed = ranked.map((r) => r.c);
  const regressions = regressed.slice(0, TOP_REGRESSIONS).map((c) => ({ name: c.name, vs7: c.vs7 }));
  const worst = regressed[0];
  if (worst) return describe('regression', worst, null, `${worst.name} moved ${Math.round(Math.abs(worst.vs7) * 100)}% the wrong way against its 7-day median, the regression with the most impact`, regressions);
  const mix = MIX_METRICS.flatMap((n) => { const c = list.find((x) => x.name === n); return c && Number.isFinite(mixGap(c)) ? [{ c, gap: mixGap(c) }] : []; });
  const far = mix.reduce<{ c: Comparison; gap: number } | null>((best, m) => (!best || m.gap > best.gap ? m : best), null);
  if (far) return describe('mix', far.c, far.gap, `nothing regressed; ${far.c.name} is ${far.gap > 0 ? 'past its target' : 'inside its target by the smallest margin'}`, regressions);
  return describe('none', null, null, 'no regression and no model-mix numbers for that day', regressions);
}

/** The status a new row starts with: `running` for an approved habit, else `proposed` (it then waits for a decision). */
export const startStatus = (habit: string | undefined): 'running' | 'proposed' => (habit !== undefined && Object.hasOwn(APPROVED_HABITS, habit) ? 'running' : 'proposed');
