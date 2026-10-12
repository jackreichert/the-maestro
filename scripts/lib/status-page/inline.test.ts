// Run: node --test scripts/lib/status-page/inline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryInline, countUnprocessed, extractFields, fillStub, unprocessed } from './inline.ts';

const PAGE = [
  '# The Podium', '', "## Today's priorities", '', '1. Ship it _[Alpha: awaiting 1 · in flight 0 · open PRs 2]_', '2. Second', '',
  '## Needs you (2)', '', '### Alpha (2)', '', '| Id | Decision |', '|---|---|', '| `ab12` | Merge it? |', '| `cd34` | Pick one |', '',
  '- [ ] `ab12` [#1](https://example.test/1)', '  > answer: ', '- [ ] `cd34`', '  > answer: ', '',
  '## PR board', '', 'text', '',
].join('\n');
const edit = (page: string, from: string, to: string): string => { assert.ok(page.includes(from), from); return page.replace(from, to); };

test('extractFields finds answers, ticks and priorities, and ignores empty stubs and the counts', () => {
  assert.deepEqual(extractFields(PAGE), { answers: {}, discuss: {}, ticks: { ab12: false, cd34: false }, priorities: ['Ship it | Alpha', 'Second'] });
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
  assert.deepEqual(u, { answers: { cd34: 'pick b' }, discuss: {}, ticks: [], priorities: ['Ship it | Alpha', 'Changed'] });
  assert.deepEqual(unprocessed(cur, base, ['Ship it | Alpha', 'Changed']).priorities, null, 'the list the generator last rendered is not an edit');
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
  assert.deepEqual(f.priorities, ['Ship it | Alpha', 'Mine']);
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
  assert.equal(carryInline(PAGE, { answers: {}, discuss: {}, ticks: [], priorities: null }, PAGE), PAGE);
});

test('a reordered priorities list keeps each stream mapping, so it can be set again unchanged', () => {
  const page = "## Today's priorities\n\nSet for 2026-10-05.\n2. Fix Y _[Beta: awaiting 0 · in flight 0 · open PRs 1]_\n1. Ship X _[Alpha: awaiting 1 · in flight 0 · open PRs 2]_\n\n## Next\n";
  assert.deepEqual(extractFields(page).priorities, ['Fix Y | Beta', 'Ship X | Alpha']);
});

test('fillStub writes an answer into the ask\'s empty stub, adds one when the stub is gone, and never overwrites a typed answer', () => {
  const filled = fillStub(PAGE, 'cd34', 'take it');
  assert.ok(filled);
  assert.deepEqual(extractFields(filled).answers, { cd34: 'take it' }, 'the answer reads back as the note path would read it');
  assert.equal(filled.split('\n').filter((l) => /answer:/.test(l)).length, 2, 'the stub was filled, not duplicated');
  const bare = fillStub(edit(PAGE, '- [ ] `cd34`\n  > answer: ', '- [ ] `cd34`'), 'cd34', 'x\ny');
  assert.deepEqual(extractFields(bare ?? '').answers, { cd34: 'x y' });
  assert.equal(fillStub(filled, 'cd34', 'other'), null, 'an existing answer stays');
  assert.equal(fillStub(PAGE, 'zz99', 'x'), null, 'an ask that is not on the page');
});

test('a discuss mark is found with or without a topic, under an ask or naming it, and does not swallow or join an answer', () => {
  const both = edit(PAGE, '`ab12` [#1](https://example.test/1)\n  > answer: ', '`ab12` [#1](https://example.test/1)\n  > answer: yes but\n  > discuss: the rollout order');
  assert.deepEqual(extractFields(both).answers, { ab12: 'yes but' });
  assert.deepEqual(extractFields(both).discuss, { ab12: 'the rollout order' });
  const bare = edit(PAGE, '- [ ] `cd34`\n  > answer: ', '- [ ] `cd34`\n  > answer: \n  > discuss:');
  assert.deepEqual(extractFields(bare).discuss, { cd34: '' }, 'a bare marker counts, with an empty topic');
  assert.deepEqual(extractFields(bare).answers, {});
  const named = edit(PAGE, '## PR board', '> discuss `ab12`: named\n\n## PR board');
  assert.deepEqual(extractFields(named).discuss, { ab12: 'named' });
  assert.deepEqual(extractFields(PAGE).discuss, {});
});

test('a new or changed discuss mark is unprocessed once, and carry puts it under the answer stub of the regenerated page', () => {
  const edited = edit(PAGE, '- [ ] `cd34`\n  > answer: ', '- [ ] `cd34`\n  > answer: \n  > discuss: which option');
  const u = unprocessed(extractFields(edited), extractFields(PAGE), undefined);
  assert.deepEqual(u.discuss, { cd34: 'which option' });
  assert.equal(countUnprocessed(u), 1);
  assert.equal(countUnprocessed(unprocessed(extractFields(edited), extractFields(edited), undefined)), 0);
  const carried = carryInline(PAGE, u, edited);
  assert.match(carried, /- \[ \] `cd34`\n {2}> answer: \n {2}> discuss: which option\n/);
  assert.deepEqual(extractFields(carried).discuss, { cd34: 'which option' });
  assert.equal(carryInline(carried, u, edited), carried, 'carrying twice changes nothing');
});

test('carry replaces an answer the generator rendered from the ledger with the user\'s newer one, rather than adding a second line', () => {
  const rendered = edit(PAGE, '- [ ] `cd34`\n  > answer: ', '- [ ] `cd34`\n  > answer: old words');
  const edited = edit(PAGE, '- [ ] `cd34`\n  > answer: ', '- [ ] `cd34`\n  > answer: new words');
  const u = unprocessed(extractFields(edited), extractFields(rendered), undefined);
  const carried = carryInline(rendered, u, edited);
  assert.equal(carried.split('answer: ').length, edited.split('answer: ').length);
  assert.deepEqual(extractFields(carried).answers, { cd34: 'new words' });
});

test('a discuss mark for an ask that left the board is kept under Unprocessed answers', () => {
  const u = { answers: {}, discuss: { zz99: 'later' }, ticks: [], priorities: null };
  assert.match(carryInline(PAGE, u, PAGE), /## Unprocessed answers\n\n- \[ \] `zz99` \(no longer on the board\)\n {2}> answer: \n {2}> discuss: later\n$/);
});
