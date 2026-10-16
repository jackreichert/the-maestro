/** Notation glyphs the Home sections share, drawn as SVG with presentation attributes only (no style attribute, so the CSP holds). */
import { s } from './dom.ts';

/** A quarter rest: the empty-state mark. */
export function restGlyph(): SVGElement {
  return s('svg', { viewBox: '0 0 14 24', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M4 1 L9.5 7.5 C7 9.5 6.5 11.5 9.5 15 L8.5 15.6 C6 14.2 3.6 15.4 5.6 19.6 C1.8 17.4 1.8 13 6.4 13.2 L2.8 8.6 C5.4 6.6 5.6 4.6 4 1 Z', fill: 'currentColor' }));
}

/** A fermata over its dot: the mark for held (blocked) work. */
export function fermataGlyph(): SVGElement {
  return s('svg', { class: 'fermata-glyph', viewBox: '0 0 20 16', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M2 13 A8 8 0 0 1 18 13', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
    s('circle', { cx: '10', cy: '11', r: '1.8', fill: 'currentColor' }));
}

/** The coda sign: a circle struck by a cross, the mark for what is shipped. */
export function codaGlyph(): SVGElement {
  return s('svg', { id: 'coda-glyph', viewBox: '0 0 20 16', 'aria-hidden': 'true', focusable: 'false' },
    s('ellipse', { cx: '10', cy: '8', rx: '4.5', ry: '5.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
    s('path', { d: 'M10 0.5V15.5M2 8H18', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }));
}

/** The brace that joins the staves of one system. */
export function braceGlyph(): SVGElement {
  return s('svg', { class: 'brace', viewBox: '0 0 14 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M12 1 C3 4 9 30 2.5 50 C9 70 3 96 12 99', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
}

/** The dynamic mark for a ratio of today to the typical day, with its gloss. The ratio is a real number from the cost payload. */
export function dynamicFor(ratio: number): { mark: string; gloss: string } {
  if (ratio < 0.7) return { mark: 'pp', gloss: 'pianissimo: well below typical' };
  if (ratio < 0.9) return { mark: 'p', gloss: 'piano: below typical' };
  if (ratio < 1) return { mark: 'mp', gloss: 'mezzo-piano: just under typical' };
  if (ratio < 1.15) return { mark: 'mf', gloss: 'mezzo-forte: about typical' };
  if (ratio < 1.4) return { mark: 'f', gloss: 'forte: above typical' };
  return { mark: 'ff', gloss: 'fortissimo: well above typical' };
}

/** A hairpin that opens (crescendo) when today is above typical and closes (diminuendo) when below. */
export function hairpin(ratio: number): SVGElement {
  const spread = Math.min(8, 2 + Math.abs(ratio - 1) * 20);
  const d = ratio >= 1 ? `M4 9 L60 ${9 - spread} M4 9 L60 ${9 + spread}` : `M4 ${9 - spread} L60 9 M4 ${9 + spread} L60 9`;
  return s('svg', { class: 'hairpin', viewBox: '0 0 64 18', 'aria-hidden': 'true', focusable: 'false' }, s('path', { d }));
}
