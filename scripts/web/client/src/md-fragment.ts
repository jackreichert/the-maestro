import { BASE_CSS, h, shadow } from './dom.ts';
import { renderMarkdown } from './markdown.ts';

const CSS = `${BASE_CSS}
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: var(--surface-2); }
  code { background: var(--surface-2); padding: 0 4px; border-radius: 3px; }
  pre { background: var(--surface-2); padding: 8px; overflow: auto; }
  blockquote { margin: 4px 0 4px 8px; padding-left: 8px; border-left: 3px solid var(--border); color: var(--text-secondary); }
  .nw { white-space: nowrap; }
  ul, ol { padding-left: 24px; }
`;

/** <md-fragment>: shows Markdown for a section not yet converted to JSON. Set `.markdown`. */
export class MdFragment extends HTMLElement {
  #root: ShadowRoot;
  #md = '';

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get markdown(): string { return this.#md; }
  set markdown(md: string) {
    this.#md = md;
    // renderMarkdown escapes all input and emits only its own tags (see markdown.test.ts); this is the one innerHTML.
    const body = h('div');
    body.innerHTML = renderMarkdown(md);
    this.#root.replaceChildren(body);
  }
}

customElements.define('md-fragment', MdFragment);

declare global { interface HTMLElementTagNameMap { 'md-fragment': MdFragment } }
