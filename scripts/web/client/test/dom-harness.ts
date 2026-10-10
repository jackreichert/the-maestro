// A small DOM for tests that need real elements: happy-dom's window installed as the globals the client reads.
// `mount()` imports a client module only after the globals exist (custom elements extend HTMLElement at import time),
// appends the element to the page, and hands back the page and a cleanup. Run with node --test; no browser needed.
import { Window } from 'happy-dom';

const GLOBALS = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'ShadowRoot', 'SVGElement', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent',
  'MutationObserver', 'CSSStyleSheet', 'customElements', 'DOMParser', 'HTMLAnchorElement', 'HTMLDetailsElement', 'HTMLButtonElement', 'location', 'history'] as const;

let installed: Window | null = null;

/** Install the globals once per test file and return the window. Idempotent. */
export function installDom(url = 'http://localhost/'): Window {
  if (installed) return installed;
  const win = new Window({ url, width: 1024, height: 768 });
  const g = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) Object.defineProperty(g, name, { value: (win as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  g.window = win;
  // happy-dom has no layout, so these report "no" or do nothing, which is what the components expect of a plain desktop.
  g.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  (win as unknown as Record<string, unknown>).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  (win as unknown as Record<string, unknown>).scrollTo = () => {};
  installed = win;
  return win;
}

export interface Mounted<T extends Element> { el: T; root: ParentNode; cleanup: () => void }

/** Create `<tag>` (after importing `modulePath` so it is defined), set `props` on it, and put it in the page. */
export async function mount<T extends HTMLElement>(modulePath: string, tag: string, props: Record<string, unknown> = {}): Promise<Mounted<T>> {
  installDom();
  await import(modulePath);
  const el = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(props)) (el as unknown as Record<string, unknown>)[k] = v;
  document.body.append(el);
  return { el, root: el.shadowRoot ?? el, cleanup: () => el.remove() };
}

/** Put an element built outside a custom element (a view function's result) in the page. */
export function place<T extends Element>(el: T): Mounted<T> {
  installDom();
  document.body.append(el);
  return { el, root: el, cleanup: () => el.remove() };
}
