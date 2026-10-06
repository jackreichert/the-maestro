/** Turn the /api/charts payload into the label/series shape podium-chart draws. Pure and DOM-free. */
import type { ChartData } from './chart-math.ts';
import type { ChartsData } from './types.ts';

/** Stacked bars: one label per day (MM-DD), one series per stream. */
export function throughputChart(c: ChartsData): ChartData {
  const streams = [...new Set(c.throughput.flatMap((d) => Object.keys(d.byStream)))].sort();
  return {
    labels: c.throughput.map((d) => d.date.slice(5)),
    series: streams.map((name) => ({ name, values: c.throughput.map((d) => d.byStream[name] ?? 0) })),
  };
}

/** Bars: open asks per age bucket. */
export function ageChart(c: ChartsData): ChartData {
  return { labels: c.ageBuckets.map((b) => b.label), series: [{ name: 'Open asks', values: c.ageBuckets.map((b) => b.count) }] };
}

/** Bars: pull requests per CI state. */
export function prMixChart(c: ChartsData): ChartData {
  const states = Object.keys(c.prMix.byState).sort();
  return { labels: states, series: [{ name: 'Pull requests', values: states.map((k) => c.prMix.byState[k]) }] };
}

/** Share: one 100% bar, one series per model family. */
export function modelMixChart(c: ChartsData): ChartData {
  const families = Object.keys(c.modelMix.byFamily).sort();
  return { labels: [c.modelMix.source === 'tokens' ? 'Tokens' : 'Items'], series: families.map((name) => ({ name, values: [c.modelMix.byFamily[name]] })) };
}
