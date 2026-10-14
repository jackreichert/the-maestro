// Run: node --test scripts/web/client/test/tabs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUE_KEYS, DASHBOARD, OPEN_PRS, OVERVIEW, formatFragment, isAllStreams, nextTab, parseFilter, parseFragment, streamTabId, tabIds, tabStream } from '../src/tabs.ts';

const ids = tabIds(['acme-widgets', 'ops', 'other']);

test('tabIds puts Home first, then Open PRs, then each stream, and does not include the retired Board tab', () => {
  assert.deepEqual(ids, ['dashboard', 'open-prs', 'others-prs', 'acme-widgets', 'ops', 'other']);
  assert.equal(ids.includes(OVERVIEW), false);
});

test('a stream named like a built-in tab gets a prefixed id, and the id maps back to the stream', () => {
  const odd = ['dashboard', 'overview', 'open-prs', 'others-prs', 'flow', 'ops'];
  const all = tabIds(odd);
  assert.deepEqual(all, ['dashboard', 'open-prs', 'others-prs', 'stream:dashboard', 'stream:overview', 'stream:open-prs', 'stream:others-prs', 'stream:flow', 'ops']);
  assert.equal(new Set(all).size, all.length, 'no two tabs share an id');
  for (const name of odd) assert.equal(tabStream(streamTabId(name)), name);
  assert.equal(tabStream(DASHBOARD), null);
  assert.equal(tabStream(OPEN_PRS), null);
  assert.equal(isAllStreams(OPEN_PRS), true);
  assert.equal(isAllStreams(OVERVIEW), false);
  assert.equal(isAllStreams('ops'), false);
});

test('parseFragment reads #tab=<id> and the bare #<id> form', () => {
  assert.equal(parseFragment('#tab=ops', ids), 'ops');
  assert.equal(parseFragment('#ops', ids), 'ops');
  assert.equal(parseFragment('#tab=acme-widgets', ids), 'acme-widgets');
  assert.equal(parseFragment('#tab=overview', ids), DASHBOARD, 'old Board links open Home');
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
  assert.equal(nextTab('ArrowRight', ids, 'dashboard'), 'open-prs');
  assert.equal(nextTab('ArrowRight', ids, 'open-prs'), 'others-prs');
  assert.equal(nextTab('ArrowRight', ids, 'other'), 'dashboard');
  assert.equal(nextTab('ArrowLeft', ids, 'dashboard'), 'other');
  assert.equal(nextTab('Home', ids, 'ops'), 'dashboard');
  assert.equal(nextTab('End', ids, 'ops'), 'other');
});

test('nextTab ignores other keys and treats an unknown current tab as the first', () => {
  assert.equal(nextTab('Enter', ids, 'ops'), null);
  assert.equal(nextTab('ArrowRight', ids, 'gone'), 'open-prs');
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
  assert.equal(parseFragment('#tab=overview&show=blocked', ids), DASHBOARD);
  const odd = tabIds(['x&y']);
  assert.equal(parseFragment(formatFragment('x&y', 'asks'), odd), 'x&y');
  assert.equal(parseFilter(formatFragment('x&y', 'asks')), 'asks');
});
