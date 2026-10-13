/** The cost widget's data for `GET /api/cost`: the daily token table against its 7-day median and targets, the model mix, and the experiment registry. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare, metricList, parseMix, readTable, shares } from '../../token-metrics.ts';
import type { Comparison, TableRow } from '../../token-metrics.ts';
import { COST_TARGETS, MODEL_PRICES } from '../../local-config.ts';
import { experimentId, parseRegistry } from '../cost-registry.ts';
import type { RegistryRow } from '../cost-registry.ts';
import type { CostData, CostExperiment, CostMetric } from '../../web/client/src/types.ts';
import { localDate } from '../status-page/priorities.ts';
import type { WebConfig } from './api.ts';

/** The metrics the widget draws, in order: the ones the loop watches. Any other metric that regressed is listed by name in `regressions`. */
export const SHOWN = ['Read/turn', 'Wakes/prompt', 'Max turns/compact', 'Opus share (read)', 'Haiku share (read)', 'Small-agent rate', 'Expiry rewrites', 'Avg report'];
const SERIES_DAYS = 14;
const RECENT_EXPERIMENTS = 5;
const CLOSED = ['adopted', 'reverted'];

export interface CostInputs { rows: Map<string, TableRow>; registry: RegistryRow[]; today: string; targets: Record<string, number>; prices?: typeof MODEL_PRICES }

const finite = (n: number): number | null => (Number.isFinite(n) ? n : null);

/** `day` shifted by `delta` days (YYYY-MM-DD in, YYYY-MM-DD out). */
function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const experiment = (r: RegistryRow): CostExperiment => ({ id: r.id, practice: r.practice, metric: r.metric, threshold: r.threshold, start: r.start, status: r.status, result: r.result });

function metricOf(c: Comparison, series: (number | null)[]): CostMetric {
  return {
    name: c.name, fmt: c.fmt as CostMetric['fmt'], today: finite(c.today), median7: finite(c.median7), vs7: finite(c.vs7), regression: c.regression,
    limit: finite(c.limit), dir: c.dir === 'max' || c.dir === 'min' ? c.dir : null, status: c.status as CostMetric['status'], series,
  };
}

/**
 * The widget's data from the table rows, the registry and the date. The newest row at or before `today` is the day shown; with none the
 * state is `empty`. Pure: the same inputs give the same answer, and nothing is read from disk here.
 */
export function buildCostWidget(i: CostInputs): CostData {
  const prices = i.prices === undefined ? MODEL_PRICES : i.prices;
  const experiments = { running: i.registry.filter((r) => r.status === 'running').map(experiment), recent: i.registry.filter((r) => CLOSED.includes(r.status)).slice(-RECENT_EXPERIMENTS).reverse().map(experiment) };
  // The runner records yesterday's numbers under yesterday's id, so a row for today or yesterday is the current proposal; today's wins.
  const proposed = [i.today, shiftDay(i.today, -1)].map((d) => i.registry.find((r) => r.id === experimentId(d))).find(Boolean);
  const base = { ...experiments, today: proposed ? experiment(proposed) : null };
  const date = [...i.rows.keys()].filter((d) => d <= i.today).sort().pop();
  if (!date) return { state: 'empty', reason: 'The token table has no day to show yet. Run token-metrics.ts --all --write.', date: null, stale: false, days: [], metrics: [], regressions: [], mix: null, ...base };
  const days = Array.from({ length: SERIES_DAYS }, (_, k) => shiftDay(date, k - SERIES_DAYS + 1));
  const getters = new Map(metricList(prices).map(([name, get]) => [name, get]));
  const all = compare(date, i.rows, '0000-00-00', { targets: i.targets, prices });
  const seriesOf = (name: string): (number | null)[] => days.map((d) => { const row = i.rows.get(d); const get = getters.get(name); return row && get ? finite(get(row)) : null; });
  const metrics = SHOWN.flatMap((n) => { const c = all.find((x) => x.name === n); return c ? [metricOf(c, seriesOf(n))] : []; });
  const mix = shares(parseMix(i.rows.get(date)?.[15]));
  return {
    state: 'ok', date, stale: date < shiftDay(i.today, -1), days, metrics, regressions: all.filter((c) => c.regression).map((c) => c.name),
    mix: { opus: finite(mix.opus ?? NaN), sonnet: finite(mix.sonnet ?? NaN), haiku: finite(mix.haiku ?? NaN), opusMax: (i.targets.opus_share_max ?? NaN) / 100, haikuMin: (i.targets.haiku_share_min ?? NaN) / 100 },
    ...base,
  };
}

/** Reads the table and the registry note under the notes vault and builds the widget. No vault root, or an unreadable note, is an `empty` answer with the reason. */
export function buildCost(cfg: WebConfig, now: Date = new Date()): CostData {
  const empty = (reason: string): CostData => ({ state: 'empty', reason, date: null, stale: false, days: [], metrics: [], regressions: [], mix: null, running: [], recent: [], today: null });
  if (!cfg.vaultRoot) return empty('No notes vault is configured (vault_root), so the token table is not read.');
  const research = join(cfg.vaultRoot, 'Projects', cfg.containerProject ?? cfg.project, 'Research');
  try {
    const note = join(research, 'token-usage-strategies.md');
    const registry = existsSync(note) ? parseRegistry(readFileSync(note, 'utf8')) : [];
    return buildCostWidget({ rows: readTable(join(research, 'token-metrics.md')), registry, today: localDate(now, cfg.page.tz), targets: COST_TARGETS });
  } catch (e) {
    return empty(`The token table could not be read (${e instanceof Error ? e.message : String(e)}).`);
  }
}
