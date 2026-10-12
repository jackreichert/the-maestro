// Run: node --test scripts/web/client/test/epic-brief.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { brief, docs } from './home-fixture.ts';
import { briefBadge, briefBadgeEl, briefView } from '../src/epic-brief.ts';
import { docsShelf } from '../src/docs-shelf.ts';
import type { EpicBrief, EpicDocs } from '../src/types.ts';

installDom();
const as = <T>(x: unknown): T => x as T;

test('a fresh brief is drawn as elements with its links checked, and no badge', () => {
  const el = briefView('avonlea-api-042', as<EpicBrief>(brief()))!;
  const { root, cleanup } = place(el);
  assert.equal(briefBadgeEl(as<EpicBrief>(brief())), null, 'a fresh brief has no badge');
  assert.equal(root.querySelector('h4')?.textContent, 'Status');
  assert.equal(root.querySelector('a')?.getAttribute('href'), 'obsidian://open?vault=Fictional&file=plan');
  assert.equal(root.querySelectorAll('ul ul li').length, 1, 'one level of nesting');
  assert.ok(root.querySelector('blockquote em'));
  cleanup();
});

test('a stale brief says so in words with the reasons, and a missing one names the command', () => {
  assert.equal(briefBadge(as<EpicBrief>(brief({ state: 'stale' }))), 'Stale brief');
  const staleBrief = as<EpicBrief>(brief({ state: 'stale', staleBecause: ['3 tickets changed', 'a plan was added'] }));
  const badge = place(briefBadgeEl(staleBrief)!);
  assert.match(badge.root.textContent ?? '', /Stale brief/);
  assert.equal(badge.root.querySelector('[aria-hidden]')?.textContent, '⚠ ', 'the glyph is decoration; the words carry the meaning');
  badge.cleanup();
  const stale = place(briefView('e-1', staleBrief)!);
  assert.match(stale.root.textContent ?? '', /Last written 2026-01-01\. 3 tickets changed; a plan was added/);
  stale.cleanup();
  assert.equal(briefBadge({ state: 'missing' }), 'No brief');
  const none = place(briefView('e-1', { state: 'missing' })!);
  assert.match(none.root.textContent ?? '', /ticket\.mjs brief e-1 --refresh/);
  none.cleanup();
});

test('brief text is never parsed as markup, and an unsafe link is plain text', () => {
  const evil = brief({ blocks: [{ type: 'paragraph', runs: [{ text: '<img src=x onerror=alert(1)>' }, { text: 'click', link: { url: 'javascript:alert(1)', kind: 'web' } }] }] });
  const { root, cleanup } = place(briefView('e-1', as<EpicBrief>(evil))!);
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('a'), null);
  assert.match(root.textContent ?? '', /<img src=x/);
  cleanup();
});

test('a fresh brief with no blocks draws nothing', () => {
  assert.equal(briefView('e-1', { state: 'fresh', blocks: [] }), null);
});

test('the docs shelf groups by kind with the overflow and the unattributed count, and nothing when empty', () => {
  const { root, cleanup } = place(docsShelf(as<EpicDocs>(docs()))!);
  assert.deepEqual([...root.querySelectorAll('h4')].map((x) => x.textContent), ['Plans', 'Runbooks']);
  assert.match(root.textContent ?? '', /2 more/);
  assert.match(root.textContent ?? '', /3 recent notes name no ticket/);
  assert.equal([...root.querySelectorAll('a')].find((a) => a.textContent === 'Cutover runbook')?.getAttribute('target'), '_blank');
  cleanup();
  assert.equal(docsShelf({ groups: [], unattributedRecent: 0 }), null);
});
