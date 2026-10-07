import { BASE_CSS, h, shadow } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import type { RenderOptions } from './markdown.ts';

const CSS = `${BASE_CSS}
  :host { font-size: var(--text-md); line-height: var(--leading-md); color: var(--text-primary); }
  div > :first-child { margin-top: 0; }
  p { margin: 0 0 var(--space-3); max-width: 75ch; }
  table { border-collapse: collapse; width: 100%; font-size: var(--text-sm); line-height: var(--leading-sm); margin: 0 0 var(--space-4); }
  th, td { border-bottom: 1px solid var(--border); padding: var(--space-2) var(--space-3) var(--space-2) 0; text-align: left; vertical-align: top; }
  thead th { border-top: 1px solid var(--border); color: var(--text-muted); font-weight: var(--weight-medium); font-size: var(--text-xs); }
  code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-family: var(--font-mono); font-size: 0.86em; }
  pre { background: var(--surface-2); padding: var(--space-3); border-radius: var(--radius-sm); overflow: auto; }
  blockquote { margin: var(--space-1) 0; padding: var(--space-1) var(--space-3); background: var(--surface-2); border-radius: var(--radius-sm); color: var(--text-secondary); }
  .nw { white-space: nowrap; }
  ul, ol { padding-left: var(--space-5); margin: 0 0 var(--space-3); }
  li { margin: var(--space-1) 0; }
`;

/** <md-fragment>: shows Markdown for a section not yet converted to JSON, or free text written by hand (set `.options` first). Set `.markdown`. */
export class MdFragment extends HTMLElement {
  #root: ShadowRoot;
  #md = '';
  #options: RenderOptions = {};

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  /** How the text is read: `autolink` for bare URLs and `breaks` for the writer's line breaks. Takes effect on the next `.markdown`. */
  set options(o: RenderOptions) { this.#options = o; }

  get markdown(): string { return this.#md; }
  set markdown(md: string) {
    this.#md = md;
    // renderMarkdown escapes all input and emits only its own tags (see markdown.test.ts); this is the one innerHTML.
    const body = h('div');
    body.innerHTML = renderMarkdown(md, this.#options);
    this.#root.replaceChildren(body);
  }
}

customElements.define('md-fragment', MdFragment);

declare global { interface HTMLElementTagNameMap { 'md-fragment': MdFragment } }
