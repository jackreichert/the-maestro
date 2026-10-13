const NAMED_SERIES: Record<string, string> = { TeamSelect: 's1', Bayada: 's2', Security: 's3', Options: 's4', Maestro: 's5', ADLs: 's6', Mithril: 's7', other: 'so' };
const SERIES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

/** A stable colour class for a stream, shared by every view that draws one: the design's known names, a hash for the rest. A class, never an inline style, so the CSP holds. */
export function seriesClass(name: string): string {
  const named = NAMED_SERIES[name];
  if (named) return named;
  let n = 0;
  for (const c of name) n = (n * 33 + c.charCodeAt(0)) >>> 0;
  return SERIES[n % SERIES.length] ?? 's1';
}
