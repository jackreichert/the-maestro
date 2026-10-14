// Run: node --test scripts/web/client/test/local-review.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import { localUnit as unit } from './home-fixture.ts';
import type { LocalReview, LocalUnit } from '../src/types.ts';

installDom();
const { verdictWords } = await import('../src/local-review.ts');
type El = HTMLElement & { review: LocalReview | null };
const u = (over: Record<string, unknown> = {}): LocalUnit => unit(over) as unknown as LocalUnit;
const review = (over: Partial<LocalReview> = {}): LocalReview => ({ generatedAt: '2026-10-11T16:00:00Z', available: true, units: [u()], more: 0, notes: [], cleanup: { landed: 0, superseded: 0, special: 0, commands: [] }, ...over });

test('a unit shows its repo, branch, commits not pushed, last commit, verdict words and the diff command', async () => {
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review() });
  const text = root.textContent ?? '';
  assert.match(text, /alpha/);
  assert.match(text, /feat\/one/);
  assert.match(text, /2 commits not pushed, last commit 4 h ago: add one/);
  assert.match(text, /Not reviewed yet/);
  assert.equal(root.querySelector('code')?.textContent, "git -C 'alpha' difftool 'origin/staging...feat/one'");
  cleanup();
});

test('a commit made this minute reads "just now", never "just now ago"', async () => {
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review({ units: [u({ at: '2026-10-11T16:00:00Z' })] }) });
  assert.match(root.textContent ?? '', /last commit just now: /);
  cleanup();
});

test('one commit reads in the singular; more units and the notes are said in words', async () => {
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review({ units: [u({ ahead: 1 })], more: 3, notes: ['Read from local git only.'] }) });
  const text = root.textContent ?? '';
  assert.match(text, /1 commit not pushed/);
  assert.match(text, /and 3 more/);
  assert.match(text, /Read from local git only\./);
  cleanup();
});

test('every verdict state has words, and a stale one is never worded as a pass', () => {
  const words = (state: string): string => verdictWords(u({ verdict: { state } })).text;
  assert.match(words('ship-it'), /SHIP IT/);
  assert.match(words('needs-work'), /NEEDS WORK/);
  assert.doesNotMatch(words('stale'), /SHIP IT/);
  assert.match(words('stale'), /earlier commit/);
  assert.match(words('none'), /Not reviewed/);
});

test('the glyph is decoration; the words are outside any aria-hidden node', async () => {
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review({ units: [u({ verdict: { state: 'ship-it' } })] }) });
  assert.equal(root.querySelector('.verdict [aria-hidden]')?.textContent, '✓ ');
  assert.match(root.querySelector('.verdict')?.textContent ?? '', /SHIP IT for this commit/);
  cleanup();
});

test('an unavailable queue gives its reason, an empty one says so, and no data says it is not available; none of them is a list', async () => {
  for (const [r, re] of [
    [review({ available: false, reason: 'No container folder is configured.', units: [] }), /No container folder is configured\./],
    [review({ units: [] }), /No live local branches are waiting/],
    [null, /not available from this page/],
  ] as const) {
    const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: r });
    assert.match(root.textContent ?? '', re);
    assert.equal(root.querySelectorAll('li').length, 0);
    cleanup();
  }
});

test('page text is data, not markup: a hostile subject stays text and nothing is a link', async () => {
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review({ units: [u({ subject: '<img src=x onerror=alert(1)>' })] }) });
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.equal(root.querySelectorAll('a').length, 0);
  assert.match(root.textContent ?? '', /<img src=x/);
  cleanup();
});

test('landed, superseded and overlay branches fold into one line with the clean-up block; the block is text to paste', async () => {
  const commands = ["git -C 'alpha' update-ref -d 'refs/heads/feat/old' abc", "git -C 'alpha' update-ref -d 'refs/heads/feat/older' def"];
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review({ cleanup: { landed: 2, superseded: 1, special: 1, commands } }) });
  assert.match(root.querySelector('summary')?.textContent ?? '', /2 already on the base, 1 superseded by a ticket key on the base, 1 local overlay \(not counted\)/);
  assert.equal(root.querySelector('pre code')?.textContent, commands.join('\n'));
  assert.equal(root.querySelectorAll('li').length, 1, 'folded rows are not listed');
  cleanup();
});

test('with no live branch the section says so and still offers the counts', async () => {
  const { root, cleanup } = await mount<El>('../src/local-review.ts', 'local-review', { review: review({ units: [], cleanup: { landed: 3, superseded: 0, special: 0, commands: [] } }) });
  assert.match(root.textContent ?? '', /No live local branches are waiting for review/);
  assert.match(root.textContent ?? '', /3 already on the base/);
  assert.equal(root.querySelector('pre'), null, 'no command block when nothing is safe to delete');
  cleanup();
});
