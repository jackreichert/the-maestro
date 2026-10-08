// Run: node --test scripts/web/client/test/keep-view.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findByKey, focusKeyOf, keepAcross, openFolds, reopenFolds } from '../src/keep-view.ts';
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

test('open disclosures are read through nested shadow roots, and only the open ones', () => {
  const a = el('details', { 'data-fold': 'unknowns' }, { open: true });
  const b = el('details', { 'data-fold': 'epics-more' }, { open: false });
  const host = el('stream-board', {}, { shadowRoot: scope(a, b) });
  assert.deepEqual(openFolds(scope(el('main'), host)), ['unknowns']);
});

test('after a redraw the same disclosures open again, and names that are gone are skipped', () => {
  const a = el('details', { 'data-fold': 'unknowns' }, { open: false });
  const b = el('details', { 'data-fold': 'epics-more' }, { open: false });
  reopenFolds(scope(el('stream-board', {}, { shadowRoot: scope(a, b) })), ['unknowns', 'left-Blocked']);
  assert.equal(a.open, true);
  assert.equal(b.open, false);
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
