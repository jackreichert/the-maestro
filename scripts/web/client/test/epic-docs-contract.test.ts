// Run: node --test scripts/web/client/test/epic-docs-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHome } from '../src/contract.ts';
import { brief, docs, home } from './home-fixture.ts';

const withEpic = (over: Record<string, unknown>): Record<string, any> => { const x = home(); Object.assign(x.epics[0], over); return x; };

test('a home epic keeps a well-formed brief and docs shelf, and a server without them is still accepted', () => {
  const got = sanitizeHome(withEpic({ brief: brief(), docs: docs() }));
  assert.equal(got?.dropped, 0);
  assert.equal(got?.home.epics[0]?.brief?.blocks?.length, 4);
  assert.equal(got?.home.epics[0]?.docs?.groups.length, 2);
  assert.equal(sanitizeHome(home())?.dropped, 0);
});

test('a block of an unknown type is skipped and counted, and the rest of the brief stays', () => {
  const b = brief();
  b.blocks.splice(1, 0, { type: 'table', rows: [] }, { type: 'heading', level: 2, runs: [{ text: 'too big' }] });
  const got = sanitizeHome(withEpic({ brief: b }));
  assert.equal(got?.home.epics[0]?.brief?.blocks?.length, 4);
  assert.equal(got?.dropped, 2);
});

test('a brief with an unknown state is dropped whole; the epic itself still renders', () => {
  const got = sanitizeHome(withEpic({ brief: brief({ state: 'great' }) }));
  assert.equal(got?.home.epics.length, 2);
  assert.equal(got?.home.epics[0]?.brief, undefined);
  assert.equal(got?.dropped, 1);
});

test('a doc with a bad shape is dropped from its group and counted', () => {
  const d = docs();
  d.groups[0].items.push({ title: 5 });
  const got = sanitizeHome(withEpic({ docs: d }));
  assert.equal(got?.home.epics[0]?.docs?.groups[0]?.items.length, 1);
  assert.equal(got?.dropped, 1);
});
