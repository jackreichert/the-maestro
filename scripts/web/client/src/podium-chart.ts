import { BASE_CSS, h, s, shadow } from './dom.ts';
import { MAX_SERIES, limitSeries, linePath, linearScale, niceTicks, shares, stack } from './chart-math.ts';
import type { ChartData } from './chart-math.ts';

export type ChartKind = 'bar' | 'line' | 'stacked' | 'share';

const W = 360;
const M = { l: 40, r: 8, t: 8, b: 30 };
const DASHES = ['', '6 3', '2 3', '8 3 2 3'];

const CSS = `${BASE_CSS}
  figure { margin: 0; }
  figcaption { font-weight: 600; margin-bottom: 4px; }
  svg { width: 100%; height: auto; display: block; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .tick { fill: var(--text-secondary); font-size: 11px; }
  ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 4px 0; padding: 0; font-size: 13px; color: var(--text-primary); }
  .swatch { display: inline-block; width: 12px; height: 12px; margin-right: 6px; vertical-align: -1px; border-radius: 2px; }
  details { font-size: 13px; }
  summary { cursor: pointer; }
  table { border-collapse: collapse; margin-top: 4px; }
  th, td { border: 1px solid var(--border); padding: 2px 8px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
`;

/** The CSS variable for series slot i (0-based); the folded "Other" series gets a neutral. */
function color(i: number, name: string): string {
  return name === 'Other' ? 'var(--series-other)' : `var(--series-${(i % MAX_SERIES) + 1})`;
}

/** <podium-chart kind="bar|line|stacked|share" title="..." desc="..." height="240">; set `.data`. */
export class PodiumChart extends HTMLElement {
  static observedAttributes = ['kind', 'title', 'desc', 'height'];
  #data: ChartData = { labels: [], series: [] };
  #root: ShadowRoot;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get data(): ChartData { return this.#data; }
  set data(d: ChartData) { this.#data = d; this.#render(); }

  connectedCallback(): void { this.#render(); }
  attributeChangedCallback(): void { this.#render(); }

  #render(): void {
    const kind = (this.getAttribute('kind') ?? 'bar') as ChartKind;
    const title = this.getAttribute('title') ?? 'Chart';
    const height = Number(this.getAttribute('height')) || 240;
    const data = limitSeries(this.#data);
    const idBase = `c${Math.abs(hash(title))}`;
    const desc = this.getAttribute('desc') ?? describe(data, kind);
    const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-labelledby': `${idBase}t ${idBase}d` },
      s('title', { id: `${idBase}t` }, title), s('desc', { id: `${idBase}d` }, desc));
    if (data.labels.length > 0) this.#plot(svg, data, kind, height);
    const legend = data.series.length > 1
      ? h('ul', { class: 'legend', 'aria-label': 'Legend' }, ...data.series.map((x, i) => h('li', {}, swatch(color(i, x.name)), x.name)))
      : null;
    this.#root.replaceChildren(h('figure', {}, h('figcaption', {}, title), svg, legend, table(data)));
  }

  #plot(svg: SVGSVGElement, data: ChartData, kind: ChartKind, height: number): void {
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
      svg.append(s('line', { class: 'grid', x1: String(M.l), x2: String(W - M.r), y1: String(y(t)), y2: String(y(t)) }),
        s('text', { class: 'tick', x: String(M.l - 6), y: String(y(t) + 4), 'text-anchor': 'end' }, pct ? `${Math.round(t * 100)}%` : String(t)));
    }
    data.labels.forEach((l, i) => {
      if (data.labels.length > 12 && i % 2 === 1) return;
      svg.append(s('text', { class: 'tick', x: String(x(i)), y: String(height - 10), 'text-anchor': 'middle' }, l));
    });
    if (kind === 'line') this.#lines(svg, data, x, y);
    else if (kind === 'bar') this.#bars(svg, data, band, x, y);
    else this.#stacks(svg, rows, names, band, x, y, pct);
  }

  #bars(svg: SVGSVGElement, data: ChartData, band: number, x: (i: number) => number, y: (v: number) => number): void {
    const w = Math.min(28, band * 0.6);
    const base = y(0);
    data.series[0]?.values.forEach((v, i) => svg.append(s('rect', {
      x: String(x(i) - w / 2), y: String(y(v)), width: String(w), height: String(Math.max(0, base - y(v))), rx: '2', fill: color(0, ''),
    }, s('title', {}, `${data.labels[i]}: ${v}`))));
  }

  #stacks(svg: SVGSVGElement, rows: Record<string, number>[], names: string[], band: number, x: (i: number) => number, y: (v: number) => number, pct: boolean): void {
    const w = Math.min(28, band * 0.6);
    rows.forEach((row, i) => {
      const vals = pct ? shares(row) : row;
      for (const seg of stack(vals, names)) {
        if (seg.value <= 0) continue;
        const idx = names.indexOf(seg.key);
        svg.append(s('rect', {
          x: String(x(i) - w / 2), y: String(y(seg.end)), width: String(w), height: String(Math.max(0, y(seg.start) - y(seg.end))),
          fill: color(idx, seg.key), stroke: 'var(--surface-1)', 'stroke-width': '2',
        }, s('title', {}, `${seg.key}: ${row[seg.key]}`)));
      }
    });
  }

  #lines(svg: SVGSVGElement, data: ChartData, x: (i: number) => number, y: (v: number) => number): void {
    data.series.forEach((ser, k) => {
      const pts = ser.values.map((v, i): [number, number] => [x(i), y(v)]);
      svg.append(s('path', { d: linePath(pts), fill: 'none', stroke: color(k, ser.name), 'stroke-width': '2', 'stroke-dasharray': DASHES[k % DASHES.length] || undefined }));
      pts.forEach(([px, py], i) => svg.append(s('circle', { cx: String(px), cy: String(py), r: '4', fill: color(k, ser.name), stroke: 'var(--surface-1)', 'stroke-width': '2' },
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
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, ''), ...data.series.map((x) => h('th', { scope: 'col' }, x.name)))),
      h('tbody', {}, ...data.labels.map((l, i) => h('tr', {}, h('th', { scope: 'row' }, l), ...data.series.map((x) => h('td', {}, String(x.values[i] ?? 0))))))));
}

function describe(data: ChartData, kind: ChartKind): string {
  const total = data.series.reduce((a, x) => a + x.values.reduce((p, q) => p + q, 0), 0);
  return `${kind} chart, ${data.labels.length} categories, ${data.series.length} series, total ${total}. A data table follows.`;
}

function hash(str: string): number {
  let n = 0;
  for (const ch of str) n = (n * 31 + ch.charCodeAt(0)) | 0;
  return n;
}

customElements.define('podium-chart', PodiumChart);

declare global { interface HTMLElementTagNameMap { 'podium-chart': PodiumChart } }
