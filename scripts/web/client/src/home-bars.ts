/** Bar pieces the Home sections share. Sized with CSSOM, not a style attribute, so the CSP holds. */
import { h } from './dom.ts';

/** A bar segment sized by weight (flex-grow). Zero-weight segments are the caller's to leave out. */
export function grow(cls: string, weight: number): HTMLElement {
  const el = h('span', { class: cls });
  el.style.flexGrow = String(weight);
  el.style.flexBasis = '0';
  return el;
}

/** A fill that is `ratio` of its track wide. */
export function fill(ratio: number): HTMLElement {
  const el = h('span', { class: 'fill' });
  el.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  return el;
}
