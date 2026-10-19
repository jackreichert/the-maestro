/**
 * The look of finishing a priority: a check that draws itself, a short burst of sparks from it, a glow on the row, a meter
 * that fills forward, and a bigger burst when the last one closes. About 1.4 s, then it rests as a calm done row.
 *
 * Hand-rolled: spans and CSS keyframes, transform and opacity only, nothing looped. Each spark's direction is a CSS rule
 * (the page's policy blocks inline styles), computed here, so the burst is the same every time and needs no randomness.
 * Under reduced motion no spark is ever created and the keyframes are off: the row simply fades in with its check.
 */
import { h, s } from './dom.ts';

/** Sparks in a card's burst and in the board-cleared burst. */
const SMALL = 12;
const LARGE = 30;

/** True when the reader asked for less motion; read at draw time, so a change of setting applies to the next celebration. */
export function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** A check that draws itself when `fresh`, and is simply there otherwise. Decorative: the row's words carry the meaning. */
export function checkMark(fresh: boolean): SVGElement {
  return s('svg', { class: `tick${fresh ? ' draw' : ''}`, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    s('circle', { class: 'ring', cx: '8', cy: '8', r: '7' }),
    s('path', { class: 'stroke', d: 'M4.6 8.4 7.1 10.9 11.6 5.4', pathLength: '1' }));
}

/** The sparks, or null under reduced motion. Decorative and out of the accessibility tree. */
export function burst(large: boolean): HTMLElement | null {
  if (reducedMotion()) return null;
  const n = large ? LARGE : SMALL;
  return h('span', { class: `burst ${large ? 'lg' : 'sm'}`, 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) => h('i', { class: `c${i % 3}` })));
}

/** Per-spark CSS: the direction and distance (--dx, --dy), spin and a small stagger, by position in the burst. */
function sparkRules(cls: string, n: number, reach: number): string {
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2 + (i % 3) * 0.12;
    const dist = reach * (0.7 + (i % 4) * 0.12);
    const dx = Math.round(Math.cos(angle) * dist);
    const dy = Math.round(Math.sin(angle) * dist);
    return `.burst.${cls} i:nth-child(${i + 1}) { --dx: ${dx}px; --dy: ${dy}px; --spin: ${(i % 2 ? 1 : -1) * (90 + (i % 5) * 40)}deg; animation-delay: ${(i % 4) * 25}ms; }`;
  }).join('\n  ');
}

export const CELEBRATE_CSS = `
  /* Done rows: the check, "Done at", a quiet strike through the stream and a green edge. Colour pairs are the contrast-tested success on success-soft. */
  ol.priorities li { position: relative; }
  ol.priorities li.done { box-shadow: inset 3px 0 0 var(--success); }
  ol.priorities li.done .tag { text-decoration: line-through; text-decoration-color: var(--success); text-decoration-thickness: 2px; }
  .text.done { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
  .chk { position: relative; display: inline-grid; place-items: center; inline-size: 1.25rem; block-size: 1.25rem; flex: none; }
  .tick { inline-size: 1.25rem; block-size: 1.25rem; overflow: visible; }
  .tick .ring { fill: var(--success-soft); stroke: var(--success); stroke-width: 1.5; }
  .tick .stroke { fill: none; stroke: var(--success); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 0; }
  .when { display: inline-block; padding: 0 var(--space-2); border-radius: var(--radius-sm); background: var(--success-soft); color: var(--success); font-size: var(--text-xs); line-height: var(--leading-xs); font-weight: var(--weight-semibold); white-space: nowrap; }

  /* The meter: how many of today's priorities are done. It fills forward from where it stood before. */
  .ttl-done { display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-3); }
  .meter { position: relative; display: inline-flex; align-items: center; gap: var(--space-2); font-variant-numeric: tabular-nums; }
  .track { position: relative; inline-size: 4.5rem; block-size: 6px; border-radius: 3px; background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); overflow: hidden; }
  .fill { --p: 0; --from: 0; position: absolute; inset: 0; transform-origin: left center; transform: scaleX(var(--p, 0)); background: var(--success); border-radius: 3px; }
  .meter.full .count { color: var(--success); font-weight: var(--weight-semibold); }
  .cleared { margin: 0; display: inline-flex; align-items: center; gap: var(--space-2); color: var(--success); font-family: var(--font-display); font-style: italic; font-size: var(--text-lg); line-height: var(--leading-lg); }

  /* The sparks: absolutely placed at the check (or the meter), moved by transform only, gone by the end of the keyframes. */
  .burst { position: absolute; inset-inline-start: 50%; inset-block-start: 50%; inline-size: 0; block-size: 0; pointer-events: none; }
  .burst i { position: absolute; inline-size: 5px; block-size: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%; opacity: 0; animation: spark 900ms var(--ease-out) both; }
  .burst.lg i { inline-size: 6px; block-size: 6px; margin: -3px 0 0 -3px; animation-duration: 1200ms; }
  .burst i.c0 { background: var(--success); }
  .burst i.c1 { background: var(--accent); }
  .burst i.c2 { background: var(--warning); border-radius: 1px; }
  ${sparkRules('sm', SMALL, 30)}
  ${sparkRules('lg', LARGE, 64)}
  @keyframes spark { 0% { opacity: 1; transform: translate(0, 0) scale(0.4) rotate(0); } 70% { opacity: 1; } 100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(1) rotate(var(--spin)); } }

  /* The moment (about 1.4 s): the check draws, the ring pops, the row glows and settles, the meter fills and pulses. */
  .tick.draw .stroke { animation: draw 420ms 120ms var(--ease-out) backwards; }
  .tick.draw .ring { transform-origin: center; animation: pop 520ms var(--ease-spring) backwards; }
  li.fresh { animation: glow 1400ms var(--ease-out); }
  li.fresh .when { animation: rise 420ms 240ms var(--ease-out) backwards; }
  .meter.fresh .fill { animation: fill 700ms var(--ease-out); }
  .meter.fresh .track { animation: pulse 900ms var(--ease-out); }
  .cleared.fresh { animation: rise 520ms 200ms var(--ease-out) backwards; }
  @keyframes draw { from { stroke-dashoffset: 1; } }
  @keyframes pop { 0% { transform: scale(0.4); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
  @keyframes glow { 0% { background-color: var(--success-soft); } 100% { background-color: transparent; } }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
  @keyframes fill { from { transform: scaleX(var(--from, 0)); } }
  @keyframes pulse { 0%, 100% { transform: scale(1); } 35% { transform: scale(1.12); } }

  /* Reduced motion: no sparks, no drawing, no scaling; the row and the line just fade in. */
  @media (prefers-reduced-motion: reduce) {
    .burst { display: none; }
    .tick.draw .stroke, .tick.draw .ring, li.fresh .when, .meter.fresh .fill, .meter.fresh .track { animation: none !important; }
    li.fresh, .cleared.fresh { animation: calm 400ms linear !important; }
  }
  @keyframes calm { from { opacity: 0; } }
  @media (forced-colors: active) { ol.priorities li.done { box-shadow: inset 3px 0 0 Highlight; } .track { forced-color-adjust: none; border: 1px solid ButtonText; } .fill { background: Highlight; } .when { border: 1px solid ButtonText; } }
`;
