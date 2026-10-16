/**
 * The score's look, shared by every Home section: an instrument name in the display italic over a plain heading, the count
 * beside it, a hint line, and an empty state that is a sentence plus the musical word for silence. Spacing groups the
 * sections; there is no card and no frame.
 */
import { h } from './dom.ts';
import { restGlyph } from './home-glyphs.ts';
import { seriesClass } from './series.ts';

export const CONCEPT_CSS = `
  /* Stream colour for notation: the series class sets --stream-color, so an SVG mark or a swatch can use currentColor or the variable. */
  .sc-s1 { --stream-color: var(--series-1); } .sc-s2 { --stream-color: var(--series-2); } .sc-s3 { --stream-color: var(--series-3); }
  .sc-s4 { --stream-color: var(--series-4); } .sc-s5 { --stream-color: var(--series-5); } .sc-s6 { --stream-color: var(--series-6); }
  .sc-s7 { --stream-color: var(--series-7); } .sc-s8 { --stream-color: var(--series-8); } .sc-so { --stream-color: var(--series-other); }

  .section { position: relative; min-width: 0; }
  .sec-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0 0 var(--space-4); padding: 0; border: 0; }
  .sec-title { display: grid; gap: 0; min-width: 0; }
  .instrument { display: block; font-family: var(--font-display); font-style: italic; font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--text-secondary); }
  .sec-title h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-xl); line-height: var(--leading-xl); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-tight); }
  .sec-title h2 .n { font-family: var(--font-mono); font-size: var(--text-sm); font-weight: var(--weight-regular); color: var(--text-muted); letter-spacing: 0; font-variant-numeric: tabular-nums; }
  .sec-title h2 svg { width: 20px; height: 16px; flex: none; color: var(--ink); }
  .sec-hint { margin: 0; max-width: 62ch; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .sec-note { margin: 0 0 var(--space-4); max-width: 62ch; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }

  /* Empty: the sentence, then the musical word for silence. */
  .tacet { display: flex; align-items: center; gap: var(--space-3); margin: 0; padding-block: var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .tacet svg { width: 14px; height: 24px; flex: none; color: var(--text-muted); transform-origin: 50% 80%; transition: transform var(--dur-slow) var(--ease-spring); }
  .tacet i { font-family: var(--font-display); font-size: var(--text-lg); color: var(--text-secondary); }
  @media (hover: hover) { .section:hover .tacet svg { transform: rotate(-8deg); } }

  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin: 0 0 var(--space-4); }
  .rows-plain { display: grid; margin: 0; padding: 0; list-style: none; }
`;

/** The stream colour class for notation (sets --stream-color). */
export const streamVar = (stream: string): string => `sc-${seriesClass(stream)}`;

/** A section: the instrument name, the heading with its count, and an optional hint, as the concept sets them. */
export function sectionHead(o: { instrument: string; title: string; plain?: string; id: string; n?: number | null; glyph?: SVGElement | null; hint?: string | Node | null; extra?: Node | null }): HTMLElement {
  return h('div', { class: 'sec-head' },
    h('div', { class: 'sec-title' },
      h('span', { class: 'instrument', 'aria-hidden': 'true' }, o.instrument),
      h('h2', { id: o.id }, o.glyph ?? null, o.title, o.plain ? h('span', { class: 'vh' }, `: ${o.plain}`) : null, o.n === undefined || o.n === null ? null : h('span', { class: 'n' }, h('span', { class: 'vh' }, ', '), String(o.n)))),
    o.hint ? h('p', { class: 'sec-hint' }, o.hint) : null,
    o.extra ?? null);
}

let seq = 0;
/** A section element named by its heading. The instrument name is decoration, so the accessible name is the heading; a musical title (Fermata, Coda) carries its plain meaning for screen readers in `plain`. */
export function conceptSection(cls: string, head: { instrument: string; title: string; plain?: string; n?: number | null; glyph?: SVGElement | null; hint?: string | Node | null; extra?: Node | null }, ...body: (Node | null)[]): HTMLElement {
  const id = `cs${++seq}`;
  return h('section', { class: `section ${cls}`, 'aria-labelledby': id }, sectionHead({ ...head, id }), ...body);
}

/** An empty state: the sentence, then the musical word for silence. */
export function tacet(text: string, word: string, lang: 'it' | 'la' = 'it'): HTMLElement {
  return h('p', { class: 'tacet' }, restGlyph(), h('span', {}, text, ' ', h('i', { lang }, word)));
}
