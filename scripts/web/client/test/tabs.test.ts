// Run: node --test scripts/web/client/test/tabs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERVIEW, formatFragment, nextTab, parseFragment, tabIds } from '../src/tabs.ts';

const ids = tabIds(['acme-widgets', 'ops', 'other']);

test('tabIds puts overview first and does not duplicate it', () => {
  assert.deepEqual(ids, ['overview', 'acme-widgets', 'ops', 'other']);
  assert.deepEqual(tabIds(['overview', 'ops']), ['overview', 'ops']);
});

test('parseFragment reads #tab=<id> and the bare #<id> form', () => {
  assert.equal(parseFragment('#tab=ops', ids), 'ops');
  assert.equal(parseFragment('#ops', ids), 'ops');
  assert.equal(parseFragment('#tab=acme-widgets', ids), 'acme-widgets');
});

test('parseFragment falls back to overview for empty, unknown, malformed and hostile values', () => {
  for (const h of ['', '#', '#tab=', '#tab=nope', '#tab=%E0%A4%A', '#tab=<script>', '#tab=__proto__']) {
    assert.equal(parseFragment(h, ids), OVERVIEW, h);
  }
});

test('formatFragment round-trips through parseFragment, including awkward names', () => {
  const odd = ['a b/c', 'x&y'];
  const all = tabIds(odd);
  for (const id of all) assert.equal(parseFragment(formatFragment(id), all), id);
  assert.equal(formatFragment('ops'), '#tab=ops');
});

test('nextTab moves right and left with wraparound, and Home/End jump to the ends', () => {
  assert.equal(nextTab('ArrowRight', ids, 'overview'), 'acme-widgets');
  assert.equal(nextTab('ArrowRight', ids, 'other'), 'overview');
  assert.equal(nextTab('ArrowLeft', ids, 'overview'), 'other');
  assert.equal(nextTab('Home', ids, 'ops'), 'overview');
  assert.equal(nextTab('End', ids, 'ops'), 'other');
});

test('nextTab ignores other keys and treats an unknown current tab as the first', () => {
  assert.equal(nextTab('Enter', ids, 'ops'), null);
  assert.equal(nextTab('ArrowRight', ids, 'gone'), 'acme-widgets');
});
