// Run: node --test scripts/web/client/test/others-prs.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { OthersPrRow, OthersPrsData } from '../src/types.ts';
import type { DraftRow } from '../src/drafts-model.ts';
import type { OthersDrafts } from '../src/others-prs.ts';

installDom();
type El = HTMLElement & { model: { data: OthersPrsData | null; loaded: boolean }; drafts: OthersDrafts };
const pr = (n: number, over: Partial<OthersPrRow> = {}): OthersPrRow => ({ repo: 'acme/app', number: n, title: `Title ${n}`, url: `https://github.com/acme/app/pull/${n}`, author: 'pat-fake', base: 'develop', updatedAt: '2026-10-15T11:00:00Z', ageDays: 3, youAsked: false, review: 'review-required', unresolved: 0, copilotThreads: 0, ...over });
const data = (prs: OthersPrRow[], over: Partial<OthersPrsData['prData']> = {}): OthersPrsData => ({ generatedAt: '2026-10-15T12:00:00Z', prData: { fetchedAt: '2026-10-15T11:55:00Z', stale: false, ...over }, total: prs.length, prs });
const draft = (n: number, over: Partial<DraftRow> = {}): DraftRow => ({ rev: '0123456789ab', id: `dr-0000000${n}`, source: 'review', repo: 'acme/app', pr: n, prUrl: `https://github.com/acme/app/pull/${n}`, severity: 'suggestion', text: 'x', state: 'pending', createdAt: '2026-10-15T10:00:00Z', ...over });
const queues: string[] = [];
const drafts = (rows: DraftRow[]): OthersDrafts => ({ rows, queue: (match, empty, quiet, authorOf) => { const el = document.createElement('div'); el.className = 'queue'; el.textContent = rows.filter(match).map((d) => `${d.repo}#${d.pr} by ${authorOf(d) ?? '?'}`).join(',') + (quiet ? '' : '|decided'); queues.push(empty); return el; } });

test('one row per PR, linked as repo#number with title, author, base, age, review state and thread counts as words', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { youAsked: true, review: 'changes-requested', unresolved: 3, copilotThreads: 2 }), pr(2, { review: 'approved' })]), loaded: true }, drafts: drafts([]) });
  const rows = [...root.querySelectorAll('li.pr')];
  assert.equal(rows.length, 2);
  const first = rows[0]?.textContent ?? '';
  for (const re of [/acme\/app#1/, /Title 1/, /by pat-fake/, /Into develop/, /Updated 1 h ago/, /Open 3 d/, /You are a requested reviewer/, /Changes requested/, /Copilot threads open: 2/, /Threads open: 3/, /No draft yet/]) assert.match(first, re);
  assert.match(rows[1]?.textContent ?? '', /You are not a requested reviewer/);
  assert.match(rows[1]?.textContent ?? '', /Approved/);
  assert.equal(root.querySelector('li.pr h3 a')?.getAttribute('href'), 'https://github.com/acme/app/pull/1');
  assert.equal(root.querySelector('ul.prs')?.getAttribute('aria-label'), 'Open teammate PRs');
  cleanup();
});

test('a PR with a waiting draft says "Draft ready" and shows the existing queue for it; a decided draft does not count', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1), pr(2)]), loaded: true }, drafts: drafts([draft(1), draft(2, { state: 'rejected' })]) });
  const [a, b] = [...root.querySelectorAll('li.pr')];
  assert.match(a?.textContent ?? '', /Draft ready/);
  assert.equal(a?.querySelector('.queue')?.textContent, 'acme/app#1 by pat-fake');
  assert.match(b?.textContent ?? '', /No draft yet/);
  assert.equal(b?.querySelector('.queue'), null);
  cleanup();
});

test('a draft on a PR that is no longer listed keeps its card, under its own heading', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1)]), loaded: true }, drafts: drafts([draft(9)]) });
  assert.match(root.querySelector('h3.orphans')?.textContent ?? '', /not listed above/);
  assert.equal(root.querySelector('.queue')?.textContent, 'acme/app#9 by ?|decided');
  cleanup();
});

test('states are said in words: loading, unavailable, empty, a failed read and an unread list', async () => {
  const load = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: null, loaded: false } });
  assert.match(load.root.textContent ?? '', /Loading/);
  load.cleanup();
  const none = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: null, loaded: true } });
  assert.match(none.root.textContent ?? '', /not available/);
  none.cleanup();
  const empty = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([], { fetchedAt: null, stale: true, failure: 'rate limited' }), loaded: true }, drafts: drafts([]) });
  assert.match(empty.root.textContent ?? '', /No teammate PR is open/);
  assert.match(empty.root.textContent ?? '', /has not been read yet/);
  assert.match(empty.root.textContent ?? '', /last read failed \(rate limited\)/);
  assert.equal(empty.root.querySelector('p.status')?.getAttribute('role'), 'status');
  empty.cleanup();
});

test('a hands-off PR says so in words', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { handsOff: true }), pr(2)]), loaded: true }, drafts: drafts([]) });
  const [a, b] = [...root.querySelectorAll('li.pr')];
  assert.match(a?.textContent ?? '', /Hands off: the repo owner's call/);
  assert.doesNotMatch(b?.textContent ?? '', /hands off/);
  cleanup();
});

test('the author sits beside repo#number: display name with login when GitHub gave a name, else the login; a draft\'s own author wins', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { authorName: 'Pat Example' }), pr(2)]), loaded: true }, drafts: drafts([draft(1), draft(2, { author: 'drafted-by-fake' })]) });
  const [a, b] = [...root.querySelectorAll('li.pr')];
  assert.match(a?.querySelector('h3')?.textContent ?? '', /acme\/app#1\s*by Pat Example \(pat-fake\)/);
  assert.match(b?.querySelector('h3')?.textContent ?? '', /acme\/app#2\s*by pat-fake/);
  assert.equal(a?.querySelector('.queue')?.textContent, 'acme/app#1 by Pat Example (pat-fake)');
  assert.equal(b?.querySelector('.queue')?.textContent, 'acme/app#2 by drafted-by-fake');
  cleanup();
});
