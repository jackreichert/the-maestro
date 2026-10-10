// Run: node --test scripts/web/client/test/keep-view.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findByKey, focusKeyOf, foldStates, keepAcross, restoreFolds } from '../src/keep-view.ts';
import { CLEAR_FILTER_ID, CUE_KEYS, tileId } from '../src/tabs.ts';
import type { KeepEl, KeepScope } from '../src/keep-view.ts';

/** A tiny stand-in for the DOM: elements with attributes, a parent and an optional shadow root, searched by tag or [data-fold]. */
function el(tag: string, attrs: Record<string, string> = {}, extra: Partial<KeepEl> = {}): KeepEl & { kids: KeepEl[] } {
  const self: KeepEl & { kids: KeepEl[] } = {
    kids: [], id: attrs.id ?? '', tagName: tag.toUpperCase(), shadowRoot: null, parentElement: null,
    getAttribute: (n) => attrs[n] ?? null, ...extra,
  };
  return self;
}
function scope(...els: KeepEl[]): KeepScope {
  return { querySelectorAll: (sel) => els.filter((e) => (sel === '*' ? true : sel === 'details[data-fold]' ? e.tagName === 'DETAILS' && e.getAttribute('data-fold') !== null : false)) };
}
function summaryOf(fold: string): KeepEl {
  return el('summary', {}, { parentElement: { getAttribute: (n) => (n === 'data-fold' ? fold : null) } });
}

test('disclosure states are read through nested shadow roots, closed ones included', () => {
  const a = el('details', { 'data-fold': 'unknowns' }, { open: true });
  const b = el('details', { 'data-fold': 'rail-links' }, { open: false });
  const host = el('stream-board', {}, { shadowRoot: scope(a, b) });
  assert.deepEqual([...foldStates(scope(el('main'), host))], [['unknowns', true], ['rail-links', false]]);
});

test('after a redraw each disclosure goes back as the reader left it, even one that starts open', () => {
  const a = el('details', { 'data-fold': 'unknowns' }, { open: false });
  const rail = el('details', { 'data-fold': 'rail-links' }, { open: true });   // open by default on a wide screen
  const fresh = el('details', { 'data-fold': 'epics-more' }, { open: false });   // not there before: keeps its default
  restoreFolds(scope(el('stream-board', {}, { shadowRoot: scope(a, rail, fresh) })), new Map([['unknowns', true], ['rail-links', false], ['gone', true]]));
  assert.equal(a.open, true);
  assert.equal(rail.open, false);
  assert.equal(fresh.open, false);
});

test('focus on a disclosure summary survives a redraw; an unnamed control has no key', () => {
  assert.deepEqual(focusKeyOf(summaryOf('unknowns')), { fold: 'unknowns' });
  assert.deepEqual(focusKeyOf(el('button', { id: 'x' })), { id: 'x' });
  assert.deepEqual(focusKeyOf(el('a', {}, { href: 'https://example.test/p' })), { href: 'https://example.test/p' });
  assert.equal(focusKeyOf(el('summary')), null);
  assert.equal(focusKeyOf(el('button')), null);
  const fresh = summaryOf('unknowns');
  const page = scope(el('stream-board', {}, { shadowRoot: scope(summaryOf('epics-more'), fresh) }));
  assert.equal(findByKey(page, { fold: 'unknowns' }), fresh);
  assert.equal(findByKey(page, { fold: 'missing' }), null);
});

test('a partial redraw keeps an open disclosure and focus inside it, as when the stream home changes', () => {
  const oldFold = el('details', { 'data-fold': 'unknowns' }, { open: true });
  const oldSummary = summaryOf('unknowns');
  const slot: KeepEl[] = [oldFold, oldSummary];
  const root: KeepScope = { querySelectorAll: (sel) => slot.filter((e) => (sel === '*' ? true : e.tagName === 'DETAILS' && e.getAttribute('data-fold') !== null)), activeElement: oldSummary };
  let focused: KeepEl | null = null;
  const newFold = el('details', { 'data-fold': 'unknowns' }, { open: false });   // the redraw rebuilds it closed
  const newSummary = { ...summaryOf('unknowns'), focus: () => { focused = newSummary; } };
  keepAcross(root, () => { slot.splice(0, slot.length, newFold, newSummary); (root as { activeElement: KeepEl | null }).activeElement = null; });
  assert.equal(newFold.open, true);
  assert.equal(focused, newSummary);
});

test('the filter tiles and the clear button have ids, so focus on them survives a live redraw', () => {
  const ids = [...CUE_KEYS.map(tileId), CLEAR_FILTER_ID];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z-]*$/);   // safe in a selector without escaping
    const old = el('button', { id });
    const fresh = el('button', { id });
    assert.deepEqual(focusKeyOf(old), { id });
    assert.equal(findByKey(scope(el('main'), fresh), { id }), fresh);
  }
});
