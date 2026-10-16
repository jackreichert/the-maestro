/** The score's look shared by Home and the other tabs: the instrument name over a heading, and the empty state as a rest plus its musical word. */
import { h } from './dom.ts';
import { restGlyph } from './home-glyphs.ts';

/** The instrument name above a heading, shared by every tab that borrows the score's look. */
export const INSTRUMENT_CSS = `
  .instrument { display: block; font-family: var(--font-display); font-style: italic; font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--text-secondary); }
`;

/** The empty state, a sentence and the musical word for silence, for tabs that do not use the whole concept stylesheet. */
export const TACET_CSS = `
  .tacet { display: flex; align-items: center; gap: var(--space-3); margin: 0; padding-block: var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .tacet svg { width: 14px; height: 24px; flex: none; color: var(--text-muted); transform-origin: 50% 80%; transition: transform var(--dur-slow) var(--ease-spring); }
  .tacet i { font-family: var(--font-display); font-size: var(--text-lg); color: var(--text-secondary); }
  @media (hover: hover) { .tacet:hover svg, .section:hover .tacet svg { transform: rotate(-8deg); } }
`;

/** An empty state: the sentence, then the musical word for silence. */
export function tacet(text: string, word: string, lang: 'it' | 'la' = 'it'): HTMLElement {
  return h('p', { class: 'tacet' }, restGlyph(), h('span', {}, text, ' ', h('i', { lang }, word)));
}
