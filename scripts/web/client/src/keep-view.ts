/**
 * What a full redraw must hand back to the reader: the disclosures they opened and the control that had focus. A live
 * ledger update rebuilds the whole page, so each disclosure carries a stable `data-fold` name, and these helpers read the
 * open ones before the redraw and open the same names after it. They take structural types so they run under node.
 */

/** A name for the control that has focus: an id, a link target, or the summary of a named disclosure. */
export interface FocusKey { id?: string; href?: string; fold?: string }

/** The slice of an element these helpers use; a real Element satisfies it. */
export interface KeepEl {
  id: string;
  tagName: string;
  href?: string;
  open?: boolean;
  focus?(): void;
  shadowRoot: KeepScope | null;
  parentElement: { getAttribute(name: string): string | null } | null;
  getAttribute(name: string): string | null;
}

/** A document, element or shadow root: anything that can be searched, shadow roots included. */
export interface KeepScope { querySelectorAll(selector: string): Iterable<KeepEl>; activeElement?: KeepEl | null }

/** Every element under `root`, descending through nested shadow roots, that matches `selector`. */
function deepAll(root: KeepScope, selector: string): KeepEl[] {
  const found = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) found.push(...deepAll(el.shadowRoot, selector));
  return found;
}

/** The names of the disclosures that are open now. */
export function openFolds(root: KeepScope): string[] {
  return deepAll(root, 'details[data-fold]').filter((d) => d.open).map((d) => d.getAttribute('data-fold') as string);
}

/** Open the disclosures with these names; names the new page no longer has are skipped. */
export function reopenFolds(root: KeepScope, names: string[]): void {
  const want = new Set(names);
  for (const d of deepAll(root, 'details[data-fold]')) if (want.has(d.getAttribute('data-fold') as string)) d.open = true;
}

/** The key for the element that has focus, or null when it has no stable name (it will not be refocused). */
export function focusKeyOf(el: KeepEl): FocusKey | null {
  if (el.id) return { id: el.id };
  if (el.tagName === 'A' && el.href) return { href: el.href };
  const fold = el.tagName === 'SUMMARY' ? el.parentElement?.getAttribute('data-fold') : null;
  return fold ? { fold } : null;
}

/** The first element under `root` (through nested shadow roots) that the key names, or null. */
export function findByKey(root: KeepScope, key: FocusKey): KeepEl | null {
  for (const el of root.querySelectorAll('*')) {
    if (key.id && el.id === key.id) return el;
    if (key.href && el.tagName === 'A' && el.href === key.href) return el;
    if (key.fold && el.tagName === 'SUMMARY' && el.parentElement?.getAttribute('data-fold') === key.fold) return el;
    const inner = el.shadowRoot ? findByKey(el.shadowRoot, key) : null;
    if (inner) return inner;
  }
  return null;
}

/** The focused element under `root`, found through nested shadow roots, or null. */
function deepActive(root: KeepScope): KeepEl | null {
  let el = root.activeElement ?? null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * Run a partial redraw of `root` and hand back what it would have thrown away: each named disclosure's state and the
 * focused control (by its key, on its twin in the new content). Any redraw that replaces nodes under an open disclosure
 * needs this, not only the full-page one.
 */
export function keepAcross(root: KeepScope, redraw: () => void): void {
  const states = openFolds(root);
  const active = deepActive(root);
  const key = active ? focusKeyOf(active) : null;
  redraw();
  reopenFolds(root, states);
  if (key) findByKey(root, key)?.focus?.();
}
