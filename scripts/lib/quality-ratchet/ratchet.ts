/**
 * Ratchet logic: compare current per-file metrics with the checked-in baseline.
 * A file in the baseline may not get worse on any metric. A file not in the baseline must
 * meet the limits outright. Pure functions here; file IO lives in `scan.ts` and the CLI.
 */
import { meetsLimits, LIMITS, type FileMetrics } from './measure.ts';

export type MetricName = keyof FileMetrics;
export const METRICS: MetricName[] = ['lines', 'longestFunction', 'maxComplexity', 'overThreshold'];

export interface LoosenRecord { file: string; metric: string; from: number | null; to: number; reason: string; date: string }

export interface Baseline {
  version: 1;
  limits: typeof LIMITS;
  files: Record<string, FileMetrics>;
  loosened: LoosenRecord[];
}

export interface Regression { file: string; metric: string; baseline: number | null; now: number }
export interface Improvement { file: string; metric: string; baseline: number; now: number }
export interface CheckResult { regressions: Regression[]; improvements: Improvement[]; stale: string[] }

/** Compare current metrics with the baseline. */
export function check(baseline: Baseline, current: Record<string, FileMetrics>): CheckResult {
  const regressions: Regression[] = [];
  const improvements: Improvement[] = [];
  for (const [file, now] of Object.entries(current)) {
    const base = baseline.files[file];
    if (!base) {
      if (!meetsLimits(now)) regressions.push(...newFileFailures(file, now));
      continue;
    }
    for (const metric of METRICS) {
      if (now[metric] > base[metric]) regressions.push({ file, metric, baseline: base[metric], now: now[metric] });
      else if (now[metric] < base[metric]) improvements.push({ file, metric, baseline: base[metric], now: now[metric] });
    }
  }
  const stale = Object.keys(baseline.files).filter((f) => !(f in current));
  return { regressions, improvements, stale };
}

function newFileFailures(file: string, now: FileMetrics): Regression[] {
  const limit: Record<MetricName, number> = {
    lines: LIMITS.fileLines, longestFunction: LIMITS.functionLines, maxComplexity: LIMITS.complexity, overThreshold: 0,
  };
  return METRICS.filter((m) => now[m] > limit[m]).map((metric) => ({ file, metric, baseline: null, now: now[metric] }));
}

export interface UpdateResult { baseline: Baseline; blocked: Regression[] }

/**
 * Next baseline from the current metrics. Only debt files are kept (files meeting every limit
 * need no entry). A worse metric or a new file over the limits is blocked unless `loosen`
 * carries a reason, which is then recorded in `loosened`. `init` (no baseline file yet)
 * adopts all existing debt.
 */
export function update(
  baseline: Baseline,
  current: Record<string, FileMetrics>,
  loosen?: { reason: string; date: string },
  init = false,
): UpdateResult {
  const regressions = init ? [] : check(baseline, current).regressions;
  if (regressions.length > 0 && !loosen) return { baseline, blocked: regressions };
  const files: Record<string, FileMetrics> = {};
  for (const file of Object.keys(current).sort()) {
    const now = current[file];
    if (!meetsLimits(now)) files[file] = now;
  }
  const loosened = [...baseline.loosened];
  if (loosen) {
    for (const r of regressions) {
      loosened.push({ file: r.file, metric: r.metric, from: r.baseline, to: r.now, reason: loosen.reason, date: loosen.date });
    }
  }
  return { baseline: { version: 1, limits: LIMITS, files, loosened }, blocked: [] };
}

/** One printable line per regression. */
export function formatRegression(r: Regression): string {
  const was = r.baseline === null ? 'new file limit exceeded' : `baseline ${r.baseline}`;
  return `${r.file}  ${r.metric}  ${was}  now ${r.now}`;
}
