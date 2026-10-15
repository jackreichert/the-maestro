/**
 * The walkers' drawings: stroke-only inline SVG, one per walker, built from constant markup and made on demand
 * (an idle page holds none). Classes only, because the page's CSP forbids style attributes; walkers-css.ts colours
 * and animates them. Ground is y = 66 in every drawing. Original art, all facing right; a walker coming from the
 * right edge is mirrored by the stage.
 */

import type { WalkerId } from './walkers-model.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const WALKER_HEIGHT = 64;

interface Drawing { w: number; body: string }

/** Two legs that swing about their hips (x1, x2 at y), each ending in a little foot. */
const legs = (x1: number, x2: number, y: number, len: number): string =>
  `<path class="leg la" d="M${x1} ${y}v${len}h-3.5"/><path class="leg lb" d="M${x2} ${y}v${len}h3.5"/>`;

const quarter = (x: number, cls: string): string => `<g class="${cls}"><ellipse cx="${x}" cy="56" rx="6.5" ry="4.6" transform="rotate(-20 ${x} 56)"/><path d="M${x + 6} 54V28"/></g>`;

const DRAWINGS: Record<WalkerId, Drawing> = {
  note: { w: 60, body: `<g class="bob">
    <ellipse cx="22" cy="36" rx="8" ry="6" transform="rotate(-20 22 36)"/><path d="M29 34V8"/><path class="flag" d="M29 8Q43 12 38 27"/>
    <circle class="dot" cx="20" cy="35" r="0.9"/>${legs(19, 26, 41, 21)}</g>` },
  metronome: { w: 60, body: `<g class="waddle"><path d="M20 61L27 11H39L46 61Z"/><path d="M17 61H49"/>
    <g class="pend"><path d="M33 55V15"/><rect x="29.5" y="24" width="7" height="5" rx="1.2"/></g><path d="M25 61v4.5M41 61v4.5"/></g>` },
  baton: { w: 130, body: `<g class="wave"><path d="M18 8L26 52"/><circle cx="26.6" cy="55" r="3"/><path d="M12 6q-4 4-3 9M22 5q4 3 3 9" class="swish"/></g>${legs(24, 29, 58, 8)}
    ${quarter(56, 'pn p1')}${quarter(84, 'pn p2')}${quarter(112, 'pn p3')}` },
  cello: { w: 80, body: `<g class="bob"><ellipse cx="40" cy="34" rx="10" ry="9"/><ellipse cx="40" cy="50" rx="14" ry="11"/><path d="M40 25V6"/><circle cx="40" cy="3.5" r="2.5"/>
    <path d="M34 44q-2.5 5 0 10M46 44q2.5 5 0 10M36 49h8"/></g>
    <g class="bow"><path d="M68 6L55 56"/></g>
    <g class="wheel wa"><circle cx="30" cy="62" r="4"/><path d="M30 58v8M26 62h8"/></g><g class="wheel wb"><circle cx="50" cy="62" r="4"/><path d="M50 58v8M46 62h8"/></g>` },
  clef: { w: 60, body: `<g class="dance"><path d="M33 2V47Q33 53 28 53Q24 53 25 49"/><path d="M33 43C19 41 19 23 33 21C45 20 45 36 34 36C28 36 27 30 31 29"/>
    <path class="arm aa" d="M25 30q-8 -7 -13 -3"/><path class="arm ab" d="M40 30q8 -7 13 -3"/>${legs(29, 36, 54, 11)}</g>` },
  drum: { w: 70, body: `<g class="bob"><ellipse cx="35" cy="30" rx="18" ry="6"/><path d="M17 30V49Q17 55 35 55T53 49V30"/><path d="M17 34l9 18l9 -18l9 18l9 -18"/>${legs(26, 44, 55, 9)}</g>
    <path class="stick sa" d="M20 4L29 24"/><path class="stick sb" d="M50 4L41 24"/>` },
  keys: { w: 130, body: [0, 1, 2, 3, 4].map((i) => `<g class="seg"><rect x="${8 + 22 * i}" y="30" width="20" height="30" rx="3"/>${[0, 1, 3].includes(i) ? `<rect x="${8 + 22 * i + 15}" y="30" width="9" height="16" rx="2"/>` : ''}<path class="leg" d="M${8 + 22 * i + 6} 60v5M${8 + 22 * i + 14} 60v5"/></g>`).join('')
    + `<g class="head"><circle class="dot" cx="106" cy="40" r="1.1"/><path d="M104 47q4 3 8 0M102 30q-2-8-6-11M112 30q2-8 6-11"/></g>` },
  record: { w: 64, body: `<g class="spin"><circle cx="32" cy="36" r="30"/><circle cx="32" cy="36" r="23"/><circle cx="32" cy="36" r="16"/><circle cx="32" cy="36" r="9"/><circle class="dot" cx="32" cy="36" r="1.6"/>
    <path d="M10 22A25 25 0 0 1 20 12M44 60A25 25 0 0 0 54 50"/></g>` },
};

/** A walker's drawing and the width it takes at WALKER_HEIGHT, so the stage can park it off screen before it sets out. */
export function buildWalker(id: WalkerId): { svg: SVGSVGElement; width: number } {
  const { w, body } = DRAWINGS[id];
  const width = Math.round((WALKER_HEIGHT * w) / 70);
  const template = document.createElement('template');
  template.innerHTML = `<svg xmlns="${SVG_NS}" class="walker w-${id}" viewBox="0 0 ${w} 70" width="${width}" height="${WALKER_HEIGHT}" aria-hidden="true" focusable="false">${body}</svg>`;   // constant markup above: no input reaches it
  return { svg: template.content.firstElementChild as SVGSVGElement, width };
}
