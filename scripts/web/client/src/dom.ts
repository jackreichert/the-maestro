/** Small DOM helpers shared by the components. Text is always set with textContent, never innerHTML. */

import { linkAttrs } from './link-policy.ts';
import { formatFragment } from './tabs.ts';

type Attrs = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined | false;

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(node: Element, attrs: Attrs, children: Child[]): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** Create an HTML element. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, attrs, children);
  return node;
}

/** Create an SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, attrs, children);
  return node;
}

/** A constructable stylesheet, so the page needs no inline style. */
export function sheet(css: string): CSSStyleSheet {
  const sh = new CSSStyleSheet();
  sh.replaceSync(css);
  return sh;
}

/** Attach an open shadow root with the given styles and return it. */
export function shadow(host: HTMLElement, css: string): ShadowRoot {
  const root = host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sheet(css)];
  return root;
}

/** A link (or plain text when the ref has no safe URL) for a server-built Ref. */
export function refLink(ref: { label: string; url?: string }): Node {
  const attrs = linkAttrs(ref.url);
  return attrs ? h('a', attrs, ref.label) : document.createTextNode(ref.label);
}

/** A link to a stream's tab, for rows and cards shown outside that tab. The href is built here, never taken from data. */
export function streamTag(stream: string): HTMLElement {
  return h('a', { class: 'tag', href: formatFragment(stream), 'aria-label': `Open the ${stream} tab` }, stream);
}

/** Visually hidden but readable by assistive tech. */
export const VISUALLY_HIDDEN = `.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}`;

/** Shared base for every component: type, links, the focus ring, mono and tabular figures. Tokens only, from theme.css. */
export const BASE_CSS = `
  :host { display: block; color: var(--text-primary); font-family: var(--font-sans); }
  :host([hidden]) { display: none; }
  *, *::before, *::after { box-sizing: border-box; }
  a {
    color: var(--accent); text-decoration-line: underline; text-decoration-thickness: 1px; text-underline-offset: 0.2em;
    text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
    transition: text-decoration-color var(--dur-fast) var(--ease-out);
  }
  a:hover { text-decoration-color: currentColor; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
  code, .mono { font-family: var(--font-mono); font-size: 0.9em; }
  .num { font-variant-numeric: tabular-nums; }
  ${VISUALLY_HIDDEN}
`;

/**
 * Shared pieces the board and the overview both draw: section headings, item rows, chips, tags, buttons, empty
 * lines and the two-column board grid. Rows switch to a stacked layout by container width, so the same row reads in
 * the narrow side column and on a phone.
 */
export const UI_CSS = `
  .board { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-7) var(--space-7); align-items: start; }
  @media (min-width: 960px) { .board { grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); } }
  @media (min-width: 1280px) { .board { grid-template-columns: minmax(0, 1fr) 360px; } }
  .col { display: grid; gap: var(--space-6); min-width: 0; }
  section { container-type: inline-size; min-width: 0; }

  .head { display: flex; align-items: baseline; gap: var(--space-2); margin: 0 0 var(--space-3); }
  .head h2 { margin: 0; font-size: var(--text-lg); line-height: var(--leading-lg); font-weight: var(--weight-semibold); letter-spacing: -0.01em; }
  .head .count { margin-left: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-regular); letter-spacing: 0; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .quiet .head h2 { font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); letter-spacing: 0.02em; }
  .glyph { display: inline-block; width: 1.1em; text-align: center; }
  .head .glyph { color: var(--text-muted); }
  .tone-critical .head .glyph { color: var(--critical); }
  .tone-success .head .glyph { color: var(--success); }
  .tone-accent .head .glyph { color: var(--accent); }

  .empty { margin: 0; padding: var(--space-3) 0; color: var(--text-muted); font-size: var(--text-sm); line-height: var(--leading-sm); border-top: 1px solid var(--border); }
  .asks { border-top: 1px solid var(--border); }
  button.more {
    font: inherit; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); color: var(--accent);
    margin-top: var(--space-2); min-height: 32px; padding: 0 var(--space-3); margin-left: calc(-1 * var(--space-3));
    border: 0; border-radius: var(--radius-sm); background: none; cursor: pointer; font-variant-numeric: tabular-nums;
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { button.more:hover { background: var(--accent-soft); } }

  ul.rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
  ul.rows > li {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px var(--space-3); align-items: baseline;
    padding: var(--space-2) 0; border-bottom: 1px solid var(--border); font-size: var(--text-md); line-height: var(--leading-md);
  }
  .row-text { min-width: 0; overflow-wrap: anywhere; }
  .row-meta { color: var(--text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .row-sub { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 2px var(--space-3); color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .gate { color: var(--critical); }
  .gate .glyph { width: auto; margin-right: 4px; }
  @container (max-width: 420px) {
    ul.rows > li { grid-template-columns: auto minmax(0, 1fr); }
    .row-meta { grid-column: 2; }
  }

  .id {
    font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-secondary);
    background: var(--surface-2); border-radius: var(--radius-sm); padding: 1px 6px; white-space: nowrap;
  }
  a.tag, span.tag {
    font-size: var(--text-sm); color: var(--text-secondary); white-space: nowrap;
    text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: var(--border-strong);
  }
  a.tag::before, span.tag::before { content: '#'; color: var(--text-muted); margin-right: 1px; }
  a.tag:hover { color: var(--accent); text-decoration-style: solid; text-decoration-color: currentColor; }

  .chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: var(--radius-pill);
    font-size: var(--text-xs); line-height: var(--leading-xs); font-weight: var(--weight-medium); white-space: nowrap;
    background: var(--surface-2); color: var(--text-secondary);
  }
  .chip.bad { background: var(--critical-soft); color: var(--critical); }
  .chip.good { background: var(--success-soft); color: var(--success); }
  .chip.warn { background: var(--warning-soft); color: var(--warning); }

  button.primary, button.secondary {
    font: inherit; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-semibold);
    min-height: 36px; padding: 0 var(--space-4); border-radius: var(--radius-sm); cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
  }
  button.primary { border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); }
  button.secondary { border: 1px solid var(--border-strong); background: var(--surface-1); color: var(--text-primary); }
  @media (hover: hover) {
    button.primary:hover:not([disabled]) { background: var(--accent-hover); border-color: var(--accent-hover); }
    button.secondary:hover:not([disabled]) { background: var(--surface-2); }
  }
  button.primary:active:not([disabled]), button.secondary:active:not([disabled]) { transform: scale(0.97); }
  button[disabled] { cursor: not-allowed; background: var(--surface-2); border-color: var(--border); color: var(--text-muted); }
`;
