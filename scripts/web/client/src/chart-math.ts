/** Scale and layout math for the hand-written SVG charts. Pure and DOM-free. */

export interface LinearScale { (v: number): number; domain: [number, number]; range: [number, number] }

/** Map a domain onto a range linearly; a zero-width domain maps to the range start. */
export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const f = (v: number): number => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
  return Object.assign(f, { domain, range });
}

/** Round-number ticks from 0 up to the first tick at or past `max`, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let n = 0; ; n++) {
    const t = Math.round(n * step * 1e9) / 1e9;
    ticks.push(t);
    if (t >= max) return ticks;
  }
}

export interface Segment { key: string; value: number; start: number; end: number }

/** Stack values in key order from zero; zero values keep a zero-width segment so keys stay aligned. */
export function stack(values: Record<string, number>, keys: string[]): Segment[] {
  let acc = 0;
  return keys.map((key) => {
    const value = Math.max(0, values[key] ?? 0);
    const seg = { key, value, start: acc, end: acc + value };
    acc += value;
    return seg;
  });
}

/** Keep the `limit - 1` largest keys and fold the rest into "Other", so a series never needs a ninth hue. */
export function foldToOther(totals: Record<string, number>, limit: number): string[] {
  const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a] || a.localeCompare(b));
  if (keys.length <= limit) return keys;
  return [...keys.slice(0, limit - 1), 'Other'];
}

/** Each key's share of the total, as fractions that sum to 1 (all zero when the total is zero). */
export function shares(values: Record<string, number>): Record<string, number> {
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, total > 0 ? v / total : 0]));
}

/** An SVG path through points as straight segments; empty input gives an empty path. */
export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}
