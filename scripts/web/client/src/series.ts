/** The colour classes the stylesheet defines: s1..s8 for named and hashed streams, `so` for the catch-all. */
const SERIES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
const CLASS = /^s(?:[1-8]|o)$/;

/** Streams with a fixed colour. The public defaults name only this tool's own streams; a deployment adds its own through `podium_series`. */
const DEFAULT_SERIES: Record<string, string> = { Security: 's3', Maestro: 's5', Mithril: 's7', other: 'so' };
let named: Record<string, string> = { ...DEFAULT_SERIES };

/** Add the server's configured stream colours (`{ Name: 's2' }`) to the defaults. Anything that is not a known colour class is ignored, so a bad payload never puts an arbitrary class on the page. */
export function configureSeries(body: unknown): void {
  named = { ...DEFAULT_SERIES };
  if (typeof body !== 'object' || body === null) return;
  for (const [name, cls] of Object.entries(body as Record<string, unknown>)) {
    if (typeof cls === 'string' && CLASS.test(cls)) named[name] = cls;
  }
}

/** A stable colour class for a stream, shared by every view that draws one: the configured and default names, a hash for the rest. A class, never an inline style, so the CSP holds. */
export function seriesClass(name: string): string {
  const fixed = Object.hasOwn(named, name) ? named[name] : undefined;
  if (fixed) return fixed;
  let n = 0;
  for (const c of name) n = (n * 33 + c.charCodeAt(0)) >>> 0;
  return SERIES[n % SERIES.length] ?? 's1';
}
