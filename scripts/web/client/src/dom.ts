/** Small DOM helpers shared by the components. Text is always set with textContent, never innerHTML. */

import { isSafeUrl } from './markdown.ts';

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

/** An href that is safe to use: http, https or obsidian only; anything else yields undefined. */
export function safeHref(url: string | undefined): string | undefined {
  return url !== undefined && isSafeUrl(url) ? url.trim() : undefined;
}

/** A link (or plain text when the ref has no safe URL) for a server-built Ref. */
export function refLink(ref: { label: string; url?: string }): Node {
  const href = safeHref(ref.url);
  return href ? h('a', { href, rel: 'noreferrer noopener' }, ref.label) : document.createTextNode(ref.label);
}

/** Visually hidden but readable by assistive tech. */
export const VISUALLY_HIDDEN = `.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}`;

/** Shared focus ring and link styling. */
export const BASE_CSS = `
  :host { display: block; color: var(--text-primary); }
  a { color: var(--accent); }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  ${VISUALLY_HIDDEN}
`;
