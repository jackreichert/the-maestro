/**
 * The daily cost experiment: which metric yesterday's numbers say to work on. Pure, so the choice is tested on fixtures and the
 * CLI (scripts/cost-experiment.ts) only reads the table and prints it.
 */
import type { Comparison } from '../token-metrics.ts';

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
 * The smallest move worth an experiment, per metric: by format (a count or token total, 5 points of a share, a quarter of a ratio,
 * 50 cents), with named overrides for the count metrics whose scale is far below a token total. A regression ranks by how many of
 * these its absolute move is worth, and a metric whose 7-day median is itself below one of them cannot be ranked at all: against a
 * base that small a percentage is noise (Expiry rewrites 37 -> 589 read as +1492%).
 */
const MATERIAL_BY_FMT: Record<string, number> = { n: 1000, pct: 0.05, ratio: 0.25, usd: 0.5 };
const MATERIAL_BY_NAME: Record<string, number> = { 'Max turns/compact': 20, 'Expiry rewrites': 50, 'Opus subagents': 5 };
const materiality = (c: Comparison): number => MATERIAL_BY_NAME[c.name] ?? MATERIAL_BY_FMT[c.fmt] ?? MATERIAL_BY_FMT.n as number;

/** How many material moves the metric's absolute change is worth; NaN when it has no number, or its median is under one material move. */
export function impact(c: Comparison): number {
  const m = materiality(c);
  if (!Number.isFinite(c.today) || !Number.isFinite(c.median7) || c.median7 < m) return NaN;
  const moved = Math.abs(c.today - c.median7);
  return moved >= m ? moved / m : NaN;
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
 * The metric to work on: the regression with the largest impact (absolute move in units of that metric's material move, either direction
 * a regression can go; moves under the floor, or from a median under it, do not count; the percentage only breaks a tie);
 * when nothing regressed, the mix metric furthest from its target (a miss beats a pass, the smallest margin beats a larger one); with
 * no number for either, `none`. Ties go to the earlier metric in the list.
 */
export function selectTarget(list: Comparison[]): Pick {
  const regressed = list.filter((c) => c.regression && Number.isFinite(c.vs7) && Number.isFinite(impact(c)))
    .sort((a, b) => impact(b) - impact(a) || Math.abs(b.vs7) - Math.abs(a.vs7));
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
