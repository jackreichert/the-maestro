// Run: node --test scripts/web/client/test/local-review-widget.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { localUnit as unit } from './home-fixture.ts';
import type { LocalReview, LocalUnit } from '../src/types.ts';

installDom();
const { localReviewWidget, WIDGET_CAP } = await import('../src/local-review-widget.ts');
const u = (over: Record<string, unknown> = {}): LocalUnit => unit(over) as unknown as LocalUnit;
const review = (over: Partial<LocalReview> = {}): LocalReview => ({ generatedAt: '2026-10-11T16:00:00Z', available: true, units: [u()], more: 0, notes: [], cleanup: { landed: 0, superseded: 0, special: 0, commands: [] }, ...over });
const draw = (r: LocalReview | null): HTMLElement => place(localReviewWidget(r)).el;

test('the widget counts the whole queue, shows only the top few, and every row links to the Open PRs tab', () => {
  const units = Array.from({ length: 5 }, (_, i) => u({ id: `local:alpha#feat/${i}`, branch: `feat/${i}` }));
  const el = draw(review({ units, more: 2 }));
  assert.match(el.querySelector('h2')!.textContent ?? '', /Waiting for local review.*7/);
  assert.equal(el.querySelectorAll('li').length, WIDGET_CAP);
  for (const a of el.querySelectorAll('a')) assert.equal(a.getAttribute('href'), '#tab=open-prs');
  assert.match(el.querySelector('.all')!.textContent ?? '', /All 7 on the Open PRs tab/);
  assert.match(el.textContent ?? '', /Not reviewed yet/);
});

test('an unreadable, missing or empty queue says so in words and has no rows', () => {
  assert.match(draw(null).textContent ?? '', /not available from this page/);
  assert.match(draw(review({ available: false, units: [], reason: 'git is not on the PATH' })).textContent ?? '', /git is not on the PATH/);
  const empty = draw(review({ units: [] }));
  assert.match(empty.textContent ?? '', /No local branch is waiting for review/);
  assert.equal(empty.querySelectorAll('li').length, 0);
});
