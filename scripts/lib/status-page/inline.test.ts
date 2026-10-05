// Run: node --test scripts/lib/status-page/inline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryInline, countUnprocessed, extractFields, unprocessed } from './inline.ts';

const PAGE = [
  '# Status now', '', "## Today's priorities", '', '1. Ship it _[Alpha: awaiting 1 · in flight 0 · open PRs 2]_', '2. Second', '',
  '## Needs you (2)', '', '### Alpha (2)', '', '| Id | Decision |', '|---|---|', '| `ab12` | Merge it? |', '| `cd34` | Pick one |', '',
  '- [ ] `ab12` [#1](https://example.test/1)', '  > answer: ', '- [ ] `cd34`', '  > answer: ', '',
  '## PR board', '', 'text', '',
].join('\n');
const edit = (page: string, from: string, to: string): string => { assert.ok(page.includes(from), from); return page.replace(from, to); };

test('extractFields finds answers, ticks and priorities, and ignores empty stubs and the counts', () => {
  assert.deepEqual(extractFields(PAGE), { answers: {}, ticks: { ab12: false, cd34: false }, priorities: ['Ship it', 'Second'] });
  const edited = edit(edit(PAGE, '`ab12` [#1](https://example.test/1)\n  > answer: ', '`ab12` [#1](https://example.test/1)\n  > answer: yes,\n  > and soon'), '- [ ] `cd34`', '- [x] `cd34`');
  const f = extractFields(edited);
  assert.deepEqual(f.answers, { ab12: 'yes, and soon' }, 'a quoted continuation joins the answer');
  assert.deepEqual(f.ticks, { ab12: false, cd34: true });
});

test('an answer typed under a table row, or naming its ask, is found', () => {
  const under = edit(PAGE, '| `cd34` | Pick one |\n', '| `cd34` | Pick one |\n> answer: the second\n');
  assert.deepEqual(extractFields(under).answers, { cd34: 'the second' });
  const named = edit(PAGE, '## PR board', '> answer `ab12`: named\n\n## PR board');
  assert.deepEqual(extractFields(named).answers, { ab12: 'named' });
});

test('page text that merely looks similar is not an edit', () => {
  assert.deepEqual(extractFields('# t\n\nsome > answer: not at line start? no, this line has text before\n- [x] done thing\n').answers, {});
  assert.deepEqual(extractFields('no priorities here').priorities, null);
});

test('unprocessed reports new or changed answers, new ticks and changed priorities, and nothing for the generator\'s own change', () => {
  const base = extractFields(PAGE);
  const cur = extractFields(edit(edit(PAGE, '2. Second', '2. Changed'), '`cd34`\n  > answer: ', '`cd34`\n  > answer: pick b'));
  const u = unprocessed(cur, base, base.priorities);
  assert.deepEqual(u, { answers: { cd34: 'pick b' }, ticks: [], priorities: ['Ship it', 'Changed'] });
  assert.deepEqual(unprocessed(cur, base, ['Ship it', 'Changed']).priorities, null, 'the list the generator last rendered is not an edit');
  assert.equal(countUnprocessed(unprocessed(base, base, base.priorities)), 0);
  assert.equal(unprocessed(cur, null, undefined).priorities, null, 'with no record of what was shown, no priorities edit is claimed');
  const same = unprocessed(cur, extractFields(edit(PAGE, '`cd34`\n  > answer: ', '`cd34`\n  > answer: pick b')), base.priorities);
  assert.deepEqual(same.answers, {}, 'an answer already in the baseline is processed');
});

test('carryInline writes answers into stubs, ticks onto boxes and the user\'s priorities block into a fresh page', () => {
  const fresh = PAGE.replace('Ship it', 'Generated one').replace('2. Second', '2. Generated two');
  const current = edit(edit(edit(PAGE, '`ab12` [#1](https://example.test/1)\n  > answer: ', '`ab12` [#1](https://example.test/1)\n  > answer: do it'), '- [ ] `cd34`', '- [x] `cd34`'), '2. Second', '2. Mine');
  const u = unprocessed(extractFields(current), extractFields(PAGE), extractFields(PAGE).priorities);
  const out = carryInline(fresh, u, current);
  const f = extractFields(out);
  assert.deepEqual(f.answers, { ab12: 'do it' });
  assert.deepEqual(f.ticks, { ab12: false, cd34: true });
  assert.deepEqual(f.priorities, ['Ship it', 'Mine']);
  assert.doesNotMatch(out, /Generated (one|two)/, 'the generated list gave way to the user\'s');
});

test('an answer for an ask that left the board is kept under Unprocessed answers, and is still read back', () => {
  const current = edit(PAGE, '`cd34`\n  > answer: ', '`cd34`\n  > answer: late reply');
  const fresh = PAGE.replace(/- \[ \] `cd34`\n {2}> answer: \n/, '');
  const out = carryInline(fresh, unprocessed(extractFields(current), extractFields(PAGE), undefined), current);
  assert.match(out, /## Unprocessed answers\n\n- \[ \] `cd34` \(no longer on the board\)\n {2}> answer: late reply\n$/);
  assert.deepEqual(extractFields(out).answers, { cd34: 'late reply' });
});

test('carryInline with nothing to carry returns the page unchanged', () => {
  assert.equal(carryInline(PAGE, { answers: {}, ticks: [], priorities: null }, PAGE), PAGE);
});
