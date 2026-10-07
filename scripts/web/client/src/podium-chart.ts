import { BASE_CSS, h, s, shadow } from './dom.ts';
import { barPath, limitSeries, linePath, linearScale, niceTicks, seriesColors, shares, stack } from './chart-math.ts';
import type { ChartData } from './chart-math.ts';

export type ChartKind = 'bar' | 'line' | 'stacked' | 'share';

/** Margins in px; the chart is drawn at its real width, so text and marks keep their size at every breakpoint. */
const M = { l: 32, r: 8, t: 8, b: 28 };
const MIN_W = 240;
const BAR_MAX = 24;
const RADIUS = 4;
const GAP = 2;
const DASHES = ['', '6 3', '2 3', '8 3 2 3'];

const CSS = `${BASE_CSS}
  figure { margin: 0; }
  figcaption { margin: 0 0 var(--space-3); font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-semibold); color: var(--text-primary); }
  svg { width: 100%; height: auto; display: block; overflow: visible; }
  .grid { stroke: var(--border); stroke-width: 1; shape-rendering: crispEdges; }
  .base { stroke: var(--border-strong); stroke-width: 1; shape-rendering: crispEdges; }
  .tick { fill: var(--text-muted); font-size: 12px; font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
  .mark { transition: opacity var(--dur-fast) var(--ease-out); }
  @media (hover: hover) { svg:hover .mark { opacity: 0.55; } svg .mark:hover { opacity: 1; } }
  ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: var(--space-3) 0 0; padding: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  ul.legend .v { color: var(--text-muted); font-variant-numeric: tabular-nums; margin-left: 4px; }
  .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 3px; }
  details { margin-top: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); }
  summary { cursor: pointer; color: var(--text-secondary); width: max-content; border-radius: 4px; }
  summary:hover { color: var(--text-primary); }
  table { border-collapse: collapse; margin-top: var(--space-2); font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid var(--border); padding: var(--space-1) var(--space-3) var(--space-1) 0; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: var(--text-muted); font-weight: var(--weight-medium); }
`;

/** <podium-chart kind="bar|line|stacked|share" label="..." desc="..." height="200">; set `.data`. */
export class PodiumChart extends HTMLElement {
  static observedAttributes = ['kind', 'label', 'title', 'desc', 'height'];
  #data: ChartData = { labels: [], series: [] };
  #root: ShadowRoot;
  #width = 360;
  #resize: ResizeObserver | null = null;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get data(): ChartData { return this.#data; }
  set data(d: ChartData) { this.#data = d; this.#render(); }

  connectedCallback(): void {
    // Redraw at the element's real width (rounded, so sub-pixel jitter does not loop) instead of scaling a fixed viewBox.
    this.#resize = new ResizeObserver(([entry]) => {
      const w = Math.max(MIN_W, Math.round(entry.contentRect.width));
      if (w !== this.#width) { this.#width = w; this.#render(); }
    });
    this.#resize.observe(this);
    this.#render();
  }

  disconnectedCallback(): void { this.#resize?.disconnect(); this.#resize = null; }
  attributeChangedCallback(): void { this.#render(); }

  #render(): void {
    const kind = (this.getAttribute('kind') ?? 'bar') as ChartKind;
    // `label`, not `title`: a title attribute on the host would show a native tooltip over the whole chart.
    const title = this.getAttribute('label') ?? this.getAttribute('title') ?? 'Chart';
    const data = limitSeries(this.#data);
    const share = kind === 'share' && data.labels.length === 1;
    const height = share ? 40 : Number(this.getAttribute('height')) || 200;
    const W = this.#width;
    const idBase = `c${Math.abs(hash(title))}`;
    const desc = this.getAttribute('desc') ?? describe(data, kind);
    const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, width: String(W), height: String(height), role: 'img', 'aria-labelledby': `${idBase}t ${idBase}d` },
      s('title', { id: `${idBase}t` }, title), s('desc', { id: `${idBase}d` }, desc));
    if (data.labels.length > 0) {
      if (share) this.#shareBar(svg, data, W, idBase);
      else this.#plot(svg, data, kind, W, height);
    }
    const total = data.series.reduce((a, x) => a + (x.values[0] ?? 0), 0);
    const colors = seriesColors(data.series.map((x) => x.name));
    const legend = data.series.length > 1
      ? h('ul', { class: 'legend', 'aria-label': 'Legend' }, ...data.series.map((x, i) => h('li', {}, swatch(colors[i]), x.name,
        share && total > 0 ? h('span', { class: 'v' }, `${Math.round(((x.values[0] ?? 0) / total) * 100)}%`) : null)))
      : null;
    this.#root.replaceChildren(h('figure', {}, h('figcaption', {}, title), svg, legend, table(data)));
  }

  /** One horizontal 100% bar: a single part-to-whole needs no axis, and a lone vertical bar wastes the panel. */
  #shareBar(svg: SVGSVGElement, data: ChartData, W: number, idBase: string): void {
    const row = Object.fromEntries(data.series.map((x) => [x.name, x.values[0] ?? 0]));
    const names = data.series.map((x) => x.name);
    const parts = shares(row);
    const colors = seriesColors(names);
    const span = W - names.filter((n) => parts[n] > 0).length * GAP + GAP;
    const clip = `${idBase}clip`;
    svg.append(s('defs', {}, s('clipPath', { id: clip }, s('rect', { x: '0', y: '8', width: String(W), height: '24', rx: String(RADIUS) }))));
    const g = s('g', { 'clip-path': `url(#${clip})` });
    let x = 0;
    names.forEach((name, i) => {
      const w = parts[name] * span;
      if (w <= 0) return;
      g.append(s('rect', { class: 'mark', x: String(x), y: '8', width: String(Math.max(0, w)), height: '24', fill: colors[i] },
        s('title', {}, `${name}: ${row[name]} (${Math.round(parts[name] * 100)}%)`)));
      x += w + GAP;
    });
    svg.append(g);
  }

  #plot(svg: SVGSVGElement, data: ChartData, kind: ChartKind, W: number, height: number): void {
    const names = data.series.map((x) => x.name);
    const rows = data.labels.map((_, i) => Object.fromEntries(data.series.map((x) => [x.name, x.values[i] ?? 0])));
    const pct = kind === 'share';
    const sums = rows.map((r) => Object.values(r).reduce((a, b) => a + b, 0));
    const peak = kind === 'stacked' ? Math.max(4, ...sums) : pct ? 1 : Math.max(4, ...data.series.flatMap((x) => x.values));
    const ticks = niceTicks(peak, 4);
    const y = linearScale([0, ticks[ticks.length - 1]], [height - M.b, M.t]);
    const band = (W - M.l - M.r) / data.labels.length;
    const x = (i: number): number => M.l + band * i + band / 2;
    for (const t of ticks) {
      svg.append(s('line', { class: t === 0 ? 'base' : 'grid', x1: String(M.l), x2: String(W - M.r), y1: String(y(t)), y2: String(y(t)) }),
        s('text', { class: 'tick', x: String(M.l - 8), y: String(y(t) + 4), 'text-anchor': 'end' }, pct ? `${Math.round(t * 100)}%` : String(t)));
    }
    const every = Math.max(1, Math.ceil(data.labels.length / Math.max(1, Math.floor((W - M.l - M.r) / 56))));
    data.labels.forEach((l, i) => {
      if (i % every !== 0) return;
      svg.append(s('text', { class: 'tick', x: String(x(i)), y: String(height - 8), 'text-anchor': 'middle' }, l));
    });
    if (kind === 'line') this.#lines(svg, data, x, y);
    else if (kind === 'bar') this.#bars(svg, data, band, x, y);
    else this.#stacks(svg, rows, names, band, x, y, pct);
  }

  #bars(svg: SVGSVGElement, data: ChartData, band: number, x: (i: number) => number, y: (v: number) => number): void {
    const w = Math.min(BAR_MAX, band * 0.6);
    const base = y(0);
    data.series[0]?.values.forEach((v, i) => {
      const d = barPath(x(i) - w / 2, y(v), w, base - y(v), RADIUS);
      if (d) svg.append(s('path', { class: 'mark', d, fill: 'var(--series-1)' }, s('title', {}, `${data.labels[i]}: ${v}`)));
    });
  }

  /** Stacked columns: a 2 px surface gap between segments, and only the top segment carries the rounded data end. */
  #stacks(svg: SVGSVGElement, rows: Record<string, number>[], names: string[], band: number, x: (i: number) => number, y: (v: number) => number, pct: boolean): void {
    const w = Math.min(BAR_MAX, band * 0.6);
    const colors = seriesColors(names);
    rows.forEach((row, i) => {
      const vals = pct ? shares(row) : row;
      const segs = stack(vals, names).filter((seg) => seg.value > 0);
      segs.forEach((seg, k) => {
        const top = k === segs.length - 1;
        const y0 = y(seg.start);
        const y1 = y(seg.end) + (top ? 0 : GAP);
        const d = barPath(x(i) - w / 2, y1, w, y0 - y1, top ? RADIUS : 0);
        if (d) svg.append(s('path', { class: 'mark', d, fill: colors[names.indexOf(seg.key)] }, s('title', {}, `${seg.key}: ${row[seg.key]}`)));
      });
    });
  }

  #lines(svg: SVGSVGElement, data: ChartData, x: (i: number) => number, y: (v: number) => number): void {
    const colors = seriesColors(data.series.map((x) => x.name));
    data.series.forEach((ser, k) => {
      const pts = ser.values.map((v, i): [number, number] => [x(i), y(v)]);
      svg.append(s('path', { class: 'mark', d: linePath(pts), fill: 'none', stroke: colors[k], 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': DASHES[k % DASHES.length] || undefined }));
      pts.forEach(([px, py], i) => svg.append(s('circle', { class: 'mark', cx: String(px), cy: String(py), r: '4', fill: colors[k], stroke: 'var(--surface-1)', 'stroke-width': '2' },
        s('title', {}, `${ser.name}, ${data.labels[i]}: ${ser.values[i]}`))));
    });
  }
}

function swatch(fill: string): HTMLElement {
  const el = h('span', { class: 'swatch', 'aria-hidden': 'true' });
  el.style.background = fill;
  return el;
}

function table(data: ChartData): HTMLElement {
  return h('details', {}, h('summary', {}, 'Data table'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, h('span', { class: 'vh' }, 'Category')), ...data.series.map((x) => h('th', { scope: 'col' }, x.name)))),
      h('tbody', {}, ...data.labels.map((l, i) => h('tr', {}, h('th', { scope: 'row' }, l), ...data.series.map((x) => h('td', {}, String(x.values[i] ?? 0))))))));
}

function describe(data: ChartData, kind: ChartKind): string {
  const total = data.series.reduce((a, x) => a + x.values.reduce((p, q) => p + q, 0), 0);
  return `${kind} chart, ${data.labels.length} categories, ${data.series.length} series, total ${total}. Open the data table below for the values.`;
}

function hash(str: string): number {
  let n = 0;
  for (const ch of str) n = (n * 31 + ch.charCodeAt(0)) | 0;
  return n;
}

customElements.define('podium-chart', PodiumChart);

declare global { interface HTMLElementTagNameMap { 'podium-chart': PodiumChart } }
