// Run: node --test scripts/web/client/test/pr-chips.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prChips } from '../src/pr-chips.ts';

const base = { ci: 'SUCCESS', isDraft: false, mergeable: 'MERGEABLE', unresolved: 0 };

test('every chip carries words or a symbol, never only a colour', () => {
  for (const ci of ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', 'NONE', 'weird']) {
    for (const c of prChips({ ...base, ci, isDraft: true, mergeable: 'CONFLICTING', unresolved: 2 })) assert.match(c.text, /[A-Za-z]/);
  }
});

test('CI states map to passing, failing and pending, case-insensitively', () => {
  assert.deepEqual(prChips(base), [{ text: '✓ CI passing', tone: 'good' }]);
  assert.equal(prChips({ ...base, ci: 'failure' })[0].tone, 'bad');
  assert.equal(prChips({ ...base, ci: 'ERROR' })[0].text, '✗ CI failing');
  assert.equal(prChips({ ...base, ci: 'PENDING' })[0].text, '• CI pending');
  assert.equal(prChips({ ...base, ci: 'NONE' })[0].text, '• CI none');
});

test('draft, conflicts and open threads add chips, with singular and plural threads', () => {
  const texts = prChips({ ...base, isDraft: true, mergeable: 'CONFLICTING', unresolved: 1 }).map((c) => c.text);
  assert.deepEqual(texts, ['✓ CI passing', 'Draft', '✗ Conflicting', '1 open thread']);
  assert.equal(prChips({ ...base, unresolved: 3 })[1].text, '3 open threads');
});
