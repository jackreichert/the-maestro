// Run: node --test scripts/web/client/test/tabs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUE_KEYS, DASHBOARD, OVERVIEW, formatFragment, isAllStreams, nextTab, parseFilter, parseFragment, streamTabId, tabIds, tabStream } from '../src/tabs.ts';

const ids = tabIds(['acme-widgets', 'ops', 'other']);

test('tabIds puts the dashboard first, then the board (id overview), then each stream', () => {
  assert.deepEqual(ids, ['dashboard', 'overview', 'acme-widgets', 'ops', 'other']);
});

test('a stream named like a built-in tab gets a prefixed id, and the id maps back to the stream', () => {
  const odd = ['dashboard', 'overview', 'flow', 'ops'];
  const all = tabIds(odd);
  assert.deepEqual(all, ['dashboard', 'overview', 'stream:dashboard', 'stream:overview', 'stream:flow', 'ops']);
  assert.equal(new Set(all).size, all.length, 'no two tabs share an id');
  for (const name of odd) assert.equal(tabStream(streamTabId(name)), name);
  assert.equal(tabStream(DASHBOARD), null);
  assert.equal(tabStream(OVERVIEW), null);
  assert.equal(isAllStreams('ops'), false);
});

test('parseFragment reads #tab=<id> and the bare #<id> form', () => {
  assert.equal(parseFragment('#tab=ops', ids), 'ops');
  assert.equal(parseFragment('#ops', ids), 'ops');
  assert.equal(parseFragment('#tab=acme-widgets', ids), 'acme-widgets');
  assert.equal(parseFragment('#tab=overview', ids), OVERVIEW, 'old Overview links still land on the board');
});

test('parseFragment falls back to the dashboard for empty, unknown, malformed and hostile values', () => {
  for (const h of ['', '#', '#tab=', '#tab=nope', '#tab=%E0%A4%A', '#tab=<script>', '#tab=__proto__']) {
    assert.equal(parseFragment(h, ids), DASHBOARD, h);
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
  assert.equal(nextTab('ArrowRight', ids, 'dashboard'), 'overview');
  assert.equal(nextTab('ArrowRight', ids, 'other'), 'dashboard');
  assert.equal(nextTab('ArrowLeft', ids, 'dashboard'), 'other');
  assert.equal(nextTab('Home', ids, 'ops'), 'dashboard');
  assert.equal(nextTab('End', ids, 'ops'), 'other');
});

test('nextTab ignores other keys and treats an unknown current tab as the first', () => {
  assert.equal(nextTab('Enter', ids, 'ops'), null);
  assert.equal(nextTab('ArrowRight', ids, 'gone'), 'overview');
});

test('parseFilter reads &show=<tile> and ignores anything that is not a tile', () => {
  for (const k of CUE_KEYS) assert.equal(parseFilter(`#tab=ops&show=${k}`), k);
  assert.equal(parseFilter('#show=blocked'), 'blocked');
  for (const h of ['', '#tab=ops', '#tab=ops&show=', '#tab=ops&show=nope', '#tab=ops&show=__proto__', '#tab=ops&show=Blocked', '#tab=ops&show=blocked%20']) {
    assert.equal(parseFilter(h), null, h);
  }
});

test('a tile filter rides on the tab fragment without disturbing the tab', () => {
  assert.equal(formatFragment('ops', 'blocked'), '#tab=ops&show=blocked');
  assert.equal(formatFragment('ops', null), '#tab=ops');
  assert.equal(parseFragment('#tab=ops&show=blocked', ids), 'ops');
  assert.equal(parseFragment('#ops&show=done', ids), 'ops');
  assert.equal(parseFragment('#tab=nope&show=done', ids), DASHBOARD);
  const odd = tabIds(['x&y']);
  assert.equal(parseFragment(formatFragment('x&y', 'asks'), odd), 'x&y');
  assert.equal(parseFilter(formatFragment('x&y', 'asks')), 'asks');
});
