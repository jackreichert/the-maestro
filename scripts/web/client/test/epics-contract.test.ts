// Run: node --test scripts/web/client/test/epics-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEpics, sanitizeHome } from '../src/contract.ts';
import { epicLine, epics, home } from './home-fixture.ts';

test('a well-formed epics body passes through whole', () => {
  const got = sanitizeEpics(epics());
  assert.equal(got?.dropped, 0);
  assert.deepEqual(got?.data.streams.map((g) => [g.stream, g.epics.length]), [['Avonlea', 1], ['Green Gables', 0]]);
  assert.equal(got?.data.unfiled[0]?.id, 'loop-lab-002');
});

test('a body with no usable shape is refused', () => {
  for (const x of [null, 'x', 3, [], {}, { streams: [] }, { streams: 'no', unfiled: [] }]) assert.equal(sanitizeEpics(x), null, JSON.stringify(x));
});

test('a line whose counts do not add up to its total, or that is malformed, is dropped and counted', () => {
  const bad = epics();
  bad.streams[0].epics.push(epicLine('x-1', { total: 99 }), epicLine('x-2', { closed: 'many' }));
  bad.unfiled.push({ id: 'x-3' });
  const got = sanitizeEpics(bad);
  assert.equal(got?.data.streams[0]?.epics.length, 1);
  assert.equal(got?.data.unfiled.length, 1);
  assert.equal(got?.dropped, 3);
});

test('a home epic may carry the PRs that name it, and a server that omits them is still accepted', () => {
  const withPrs = home();
  withPrs.epics[0].prs = [{ label: 'avonlea-api#412', url: 'https://github.test/acme/avonlea-api/pull/412' }];
  assert.equal(sanitizeHome(withPrs)?.dropped, 0);
  assert.equal(sanitizeHome(home())?.dropped, 0);
  const bad = home();
  bad.epics[0].prs = 'no';
  assert.ok((sanitizeHome(bad)?.dropped ?? 0) > 0);
});
