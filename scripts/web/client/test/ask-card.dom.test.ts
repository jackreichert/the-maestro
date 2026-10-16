// Run: node --test scripts/web/client/test/ask-card.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { AskCard } from '../src/types.ts';

installDom();
type Card = HTMLElement & { ask: AskCard | null; locked: boolean };

const base: AskCard = { id: 'ab12', stream: 'Alpha', needed: 'Ship Friday or Monday?', context: '', ageDays: 0.2, date: '2026-10-13', ts: '2026-10-13T10:00:00.000Z', links: { tracker: [], prs: [] } };
const templated: AskCard = {
  ...base, recommend: 'Monday, it is safer.', door: 'one-way', searched: 'the README and the ledger',
  sections: {
    blocked: 'The release waits on the answer.', context: ['CI is green', 'Two reviewers are away'],
    options: [{ option: 'Friday', cost: 'risks a weekend fix' }, { option: 'Monday', cost: 'a three day delay' }],
    links: [{ label: 'PR 7', url: 'https://example.test/pull/7' }, { label: 'Plan', url: 'obsidian://open?vault=Fictional&file=Plan' }],
  },
};

const open = (el: Card, root: ParentNode): void => { (root.querySelector('button.ask-toggle') as HTMLElement).click(); void el; };

test('a templated ask shows its sections under headings in the fixed order, with the answer box last', async () => {
  const { el, root, cleanup } = await mount<Card>('../src/ask-card.ts', 'ask-card', { ask: templated });
  open(el, root);
  const headings = [...root.querySelectorAll('.body h4')].map((n) => n.textContent);
  assert.deepEqual(headings, ['Question', 'What is blocked', 'Context', 'Options', 'Recommend', 'Links', 'What I checked']);
  const sec = (key: string): string => root.querySelector(`.sec-${key}`)?.textContent ?? '';
  assert.match(sec('question'), /Ship Friday or Monday\?/);
  assert.match(sec('blocked'), /waits on the answer/);
  assert.deepEqual([...root.querySelectorAll('.sec-context li')].map((n) => n.textContent), ['CI is green', 'Two reviewers are away']);
  const opts = [...root.querySelectorAll('.sec-options li')].map((n) => n.textContent ?? '');
  assert.equal(opts.length, 2);
  assert.match(opts[0]!, /Friday.*cost: risks a weekend fix/);
  assert.match(sec('recommendation'), /Monday, it is safer\./);
  assert.match(sec('checked'), /the README and the ledger/);
  // Every section comes before the answer form, which is the last thing in the body.
  const body = root.querySelector('.body')!;
  const kids = [...body.children];
  assert.ok(kids.at(-1)!.classList.contains('form'), 'the answer box is last');
  assert.ok(kids.slice(0, -1).every((k) => !k.classList.contains('form')));
  assert.ok(root.querySelector('.form textarea'));
  cleanup();
});

test('the links of a templated ask are clickable anchors and an unsafe URL is text', async () => {
  const bad: AskCard = { ...templated, sections: { ...templated.sections!, links: [...templated.sections!.links, { label: 'bad', url: 'javascript:alert(1)' }] } };
  const { el, root, cleanup } = await mount<Card>('../src/ask-card.ts', 'ask-card', { ask: bad });
  open(el, root);
  const anchors = [...root.querySelectorAll<HTMLAnchorElement>('.sec-links a')];
  assert.deepEqual(anchors.map((a) => a.getAttribute('href')), ['https://example.test/pull/7', 'obsidian://open?vault=Fictional&file=Plan']);
  assert.match(root.querySelector('.sec-links')!.textContent ?? '', /bad/, 'the unsafe one is shown as plain text');
  cleanup();
});

test('an older free-text ask renders in the legacy layout, with no section headings', async () => {
  const legacy: AskCard = { ...base, needed: 'Merge it?', context: 'The context is here.', recommend: 'yes', links: { tracker: [], prs: [{ label: '#12', url: 'https://example.test/pull/12' }] } };
  const { el, root, cleanup } = await mount<Card>('../src/ask-card.ts', 'ask-card', { ask: legacy });
  open(el, root);
  assert.equal(root.querySelectorAll('.body h4').length, 0);
  assert.equal((root.querySelector('.context') as unknown as { markdown: string } | null)?.markdown, 'The context is here.', 'the free-text context is the md-fragment as before');
  assert.match(root.querySelector('.recommend')?.textContent ?? '', /Recommend.*yes/);
  assert.doesNotMatch(root.querySelector('.decide')?.textContent ?? '', /Recommend/, 'it is a block of its own, not a row in the details');
  assert.equal(root.querySelectorAll('.links a').length, 1);
  assert.ok(root.querySelector('.form textarea'));
  cleanup();
});

test('the recommendation is its own labelled block, apart from the question and context, in both layouts', async () => {
  for (const ask of [templated, { ...base, needed: 'Merge it?', context: 'ctx', recommend: 'yes' } as AskCard]) {
    const { el, root, cleanup } = await mount<Card>('../src/ask-card.ts', 'ask-card', { ask });
    open(el, root);
    const blocks = root.querySelectorAll('.recommend');
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    assert.match(block.textContent ?? '', /^Recommend/);
    assert.ok(!block.contains(root.querySelector('.sec-question')) && !block.contains(root.querySelector('.sec-context')), 'the question and context are not inside it');
    assert.equal(root.querySelectorAll('.recommend').length, 1, 'said once, not repeated in the details list');
    cleanup();
  }
});
