// Run: node --test scripts/web/client/test/others-prs.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { OthersPrRow, OthersPrsData } from '../src/types.ts';
import type { DraftRow } from '../src/drafts-model.ts';
import type { OthersActions, OthersDrafts } from '../src/others-prs.ts';

installDom();
type El = HTMLElement & { model: { data: OthersPrsData | null; loaded: boolean }; drafts: OthersDrafts; actions: OthersActions };
const pr = (n: number, over: Partial<OthersPrRow> = {}): OthersPrRow => ({ repo: 'acme/app', number: n, title: `Title ${n}`, url: `https://github.com/acme/app/pull/${n}`, author: 'pat-fake', base: 'develop', updatedAt: '2026-10-15T11:00:00Z', ageDays: 3, youAsked: false, review: 'review-required', unresolved: 0, copilotThreads: 0, ...over });
const data = (prs: OthersPrRow[], over: Partial<OthersPrsData['prData']> = {}): OthersPrsData => ({ generatedAt: '2026-10-15T12:00:00Z', prData: { fetchedAt: '2026-10-15T11:55:00Z', stale: false, ...over }, total: prs.length, prs });
const draft = (n: number, over: Partial<DraftRow> = {}): DraftRow => ({ rev: '0123456789ab', id: `dr-0000000${n}`, source: 'review', repo: 'acme/app', pr: n, prUrl: `https://github.com/acme/app/pull/${n}`, severity: 'suggestion', text: 'x', state: 'pending', createdAt: '2026-10-15T10:00:00Z', ...over });
const queues: string[] = [];
const pick = (root: ParentNode, id: string): void => { (root.querySelector(`button.tab[data-tab="${id}"]`) as HTMLButtonElement).click(); };
const drafts = (rows: DraftRow[]): OthersDrafts => ({ rows, queue: (match, empty, quiet, authorOf) => { const el = document.createElement('div'); el.className = 'queue'; el.textContent = rows.filter(match).map((d) => `${d.repo}#${d.pr} by ${authorOf(d) ?? '?'}`).join(',') + (quiet ? '' : '|decided'); queues.push(empty); return el; } });

test('one row per PR, linked as repo#number with title, author, base, age, review state and thread counts as words', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { youAsked: true, review: 'changes-requested', unresolved: 3, copilotThreads: 2 }), pr(2, { review: 'approved', unresolved: 1 })]), loaded: true }, drafts: drafts([]) });
  pick(root, 'threads');
  const rows = [...root.querySelectorAll('li.pr')];
  assert.equal(rows.length, 2);
  const first = rows[0]?.textContent ?? '';
  for (const re of [/acme\/app#1/, /Title 1/, /by pat-fake/, /Into develop/, /Updated 1 h ago/, /Open 3 d/, /You are a requested reviewer/, /Changes requested/, /Copilot threads open: 2/, /Threads open: 3/, /No review yet/]) assert.match(first, re);
  assert.match(rows[1]?.textContent ?? '', /You are not a requested reviewer/);
  assert.match(rows[1]?.textContent ?? '', /Approved/);
  assert.equal(root.querySelector('li.pr h3 a')?.getAttribute('href'), 'https://github.com/acme/app/pull/1');
  assert.equal(root.querySelector('ul.prs')?.getAttribute('aria-label'), 'Open teammate PRs');
  cleanup();
});

test('a PR with a waiting draft says "Draft ready" and shows the existing queue for it; a decided draft does not count', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1), pr(2)]), loaded: true }, drafts: drafts([draft(1), draft(2, { state: 'rejected' })]) });
  const b = root.querySelector('li.pr');
  assert.equal(numbers(root).join(), '2', 'a decided draft leaves the PR in its own tab');
  pick(root, 'in-review');
  const a = root.querySelector('li.pr');
  assert.match(a?.textContent ?? '', /Draft ready/);
  assert.equal(a?.querySelector('.queue')?.textContent, 'acme/app#1 by pat-fake');
  assert.match(b?.textContent ?? '', /No review yet/);
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
  assert.ok(empty.root.querySelector('p.tacet svg'), 'the empty state is the score\'s rest and its word');
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
  pick(root, 'in-review');
  const [a, b] = [...root.querySelectorAll('li.pr')];
  assert.match(a?.querySelector('h3')?.textContent ?? '', /acme\/app#1\s*by Pat Example \(pat-fake\)/);
  assert.match(b?.querySelector('h3')?.textContent ?? '', /acme\/app#2\s*by pat-fake/);
  assert.equal(a?.querySelector('.queue')?.textContent, 'acme/app#1 by Pat Example (pat-fake)');
  assert.equal(b?.querySelector('.queue')?.textContent, 'acme/app#2 by drafted-by-fake');
  cleanup();
});

const many = (n: number, over: (i: number) => Partial<OthersPrRow> = () => ({})): OthersPrRow[] => Array.from({ length: n }, (_, i) => pr(i + 1, over(i + 1)));
const numbers = (root: ParentNode): number[] => [...root.querySelectorAll('li.pr')].map((l) => Number((l.getAttribute('data-pr') ?? '').split('#')[1]));

const pagerText = (root: ParentNode): string | undefined => root.querySelector('nav.pager .pg-status')?.textContent ?? undefined;
const press = (root: ParentNode, dir: 'prev' | 'next'): void => (root.querySelector(`nav.pager [data-dir=${dir}]`) as HTMLButtonElement).click();

test('a long list shows 25 rows, "Page 1 of 3" in a pager, and says the page in a live region', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(many(60)), loaded: true }, drafts: drafts([]) });
  assert.equal(root.querySelectorAll('li.pr').length, 25);
  assert.equal(pagerText(root), 'Page 1 of 3 (1\u201325 of 60)');
  assert.equal(root.querySelector('p.vh[role=status]')?.textContent, '60 in Ready for approval, page 1 of 3');
  assert.equal(root.querySelector('nav.pager')?.getAttribute('aria-label'), 'Ready for approval pages');
  assert.equal(root.querySelector('nav.pager [data-dir=prev]')?.getAttribute('aria-disabled'), 'true', 'there is no page before the first');
  cleanup();
});

test('Next shows the next 25 and keeps focus on the pager; Previous goes back; the last page shows what is left', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(many(60)), loaded: true }, drafts: drafts([]) });
  press(root, 'next');
  assert.deepEqual([numbers(root).length, numbers(root)[0], pagerText(root)], [25, 26, 'Page 2 of 3 (26\u201350 of 60)']);
  assert.equal((root as unknown as ShadowRoot).activeElement?.getAttribute('data-dir'), 'next', 'focus stays on the button pressed');
  press(root, 'next');
  assert.deepEqual([numbers(root).length, numbers(root)[0], pagerText(root)], [10, 51, 'Page 3 of 3 (51\u201360 of 60)']);
  assert.equal(root.querySelector('nav.pager [data-dir=next]')?.getAttribute('aria-disabled'), 'true');
  press(root, 'next');
  assert.equal(numbers(root)[0], 51, 'Next on the last page does nothing');
  press(root, 'prev');
  assert.equal(numbers(root)[0], 26);
  cleanup();
});

test('rows that ask you to review stay above the paging, never behind it', async () => {
  const list = many(80, (n) => (n === 70 || n === 75 ? { youAsked: true } : {}));
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(list), loaded: true }, drafts: drafts([]) });
  const first = numbers(root);
  assert.deepEqual(first.slice(0, 2), [70, 75], 'rows asked of you lead, in list order');
  assert.equal(first.length, 2 + 25);
  assert.equal(pagerText(root), 'Page 1 of 4 (1\u201325 of 78)');
  assert.equal(new Set(first).size, first.length, 'a pinned row is not listed twice');
  cleanup();
});

test('a list of 25 or fewer has no pager', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(many(25)), loaded: true }, drafts: drafts([]) });
  assert.equal(root.querySelector('nav.pager'), null);
  assert.equal(root.querySelectorAll('li.pr').length, 25);
  cleanup();
});

test('a redraw (a draft appearing) keeps the page the reader is on', async () => {
  const { el, root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(many(60)), loaded: true }, drafts: drafts([]) });
  press(root, 'next');
  el.drafts = drafts([draft(3)]);
  assert.equal(pagerText(root), 'Page 2 of 3 (26\u201350 of 59)', 'the drafted PR moved to In review, and the page held');
  cleanup();
});

test('five sub-tabs with a count on each label; Ready for approval opens first and Stale is last and muted', async () => {
  const rows = [pr(1), pr(2, { unresolved: 2 }), pr(3, { ci: 'fail' }), pr(4, { awaitingAuthor: true }), pr(5, { stale: true, staleWhy: 'Slack post 3d, no reply' }), pr(6)];
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(rows), loaded: true }, drafts: drafts([]) });
  const tabs = [...root.querySelectorAll('button.tab')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Ready for approval (2)', 'Threads open (1)', 'Not ready (1)', 'In review (1)', 'Stale (1)']);
  assert.equal(root.querySelector('[role=tablist]')?.getAttribute('aria-label'), 'Teammate PRs by state');
  assert.deepEqual(tabs.map((t) => [t.getAttribute('aria-selected'), t.getAttribute('tabindex')]), [['true', '0'], ['false', '-1'], ['false', '-1'], ['false', '-1'], ['false', '-1']]);
  assert.ok(tabs[4]?.classList.contains('muted'));
  assert.equal(numbers(root).join(), '1,6');
  const panel = root.querySelector('[role=tabpanel]');
  assert.equal(panel?.getAttribute('aria-labelledby'), 'tab-ready');
  assert.equal(tabs[0]?.getAttribute('aria-controls'), panel?.id);
  cleanup();
});

test('arrow keys, Home and End move between tabs and focus follows', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1), pr(2, { unresolved: 1 })]), loaded: true }, drafts: drafts([]) });
  const press = (key: string): void => { (root.querySelector('button.tab[aria-selected=true]') as HTMLElement).dispatchEvent(new (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); };
  press('ArrowRight');
  assert.equal(root.querySelector('button.tab[aria-selected=true]')?.getAttribute('data-tab'), 'threads');
  assert.equal(numbers(root).join(), '2');
  assert.equal((root as unknown as ShadowRoot).activeElement?.getAttribute('data-tab'), 'threads');
  press('End');
  assert.equal(root.querySelector('button.tab[aria-selected=true]')?.getAttribute('data-tab'), 'stale');
  press('ArrowRight');
  assert.equal(root.querySelector('button.tab[aria-selected=true]')?.getAttribute('data-tab'), 'ready');
  press('ArrowLeft');
  assert.equal(root.querySelector('button.tab[aria-selected=true]')?.getAttribute('data-tab'), 'stale');
  cleanup();
});

test('an empty sub-tab says why in words and its panel can take focus', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1)]), loaded: true }, drafts: drafts([]) });
  pick(root, 'stale');
  assert.equal(root.querySelector('[role=tabpanel]')?.getAttribute('tabindex'), '0');
  cleanup();
});

test('a click on a tab keeps focus on that tab; the hidden live region survives redraws; modifier keys are left alone', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1), pr(2, { unresolved: 1 })]), loaded: true }, drafts: drafts([]) });
  const live = root.querySelector('p.vh[role=status]');
  pick(root, 'threads');
  assert.equal((root as unknown as ShadowRoot).activeElement?.getAttribute('data-tab'), 'threads');
  assert.equal(root.querySelector('p.vh[role=status]'), live, 'the same node, never re-created');
  const key = new (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true });
  (root.querySelector('button.tab[aria-selected=true]') as HTMLElement).dispatchEvent(key);
  assert.equal(root.querySelector('button.tab[aria-selected=true]')?.getAttribute('data-tab'), 'threads');
  cleanup();
});

test('an empty sub-tab says why in words, not a blank panel', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1)]), loaded: true }, drafts: drafts([]) });
  pick(root, 'stale');
  assert.match(root.querySelector('[role=tabpanel]')?.textContent ?? '', /Nothing has gone stale/);
  assert.equal(root.querySelector('li.pr'), null);
  cleanup();
});

test('Not ready rows show each reason; Stale rows show the author, the last ask and why it went stale', async () => {
  const rows = [pr(1, { ci: 'fail', conflicting: true }), pr(2, { notAsked: true }), pr(3, { stale: true, staleWhy: 'never posted, opened 4d ago', askedAt: '2026-10-11T12:00:00Z', authorName: 'Pat Example' })];
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(rows), loaded: true }, drafts: drafts([]) });
  pick(root, 'not-ready');
  const [a, b] = [...root.querySelectorAll('li.pr')];
  assert.match(a?.textContent ?? '', /Checks failing/);
  assert.match(a?.textContent ?? '', /Merge conflict/);
  assert.match(b?.textContent ?? '', /Not asked yet/);
  pick(root, 'stale');
  const t = root.querySelector('li.pr')?.textContent ?? '';
  for (const re of [/by Pat Example \(pat-fake\)/, /Last ask 4 d ago/, /never posted, opened 4d ago/]) assert.match(t, re);
  cleanup();
});

test('every row says how long its author has waited, and the longest wait leads inside a tab', async () => {
  const rows = [pr(1, { askedAt: '2026-10-15T09:00:00Z' }), pr(2, { askedAt: '2026-10-14T12:00:00Z' }), pr(3, { askedAt: '2026-10-15T11:00:00Z' }), pr(4)];
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(rows), loaded: true }, drafts: drafts([]) });
  assert.deepEqual(numbers(root), [2, 1, 3, 4], 'oldest ask first; a PR with no known ask last');
  const [first, second] = [...root.querySelectorAll('li.pr')];
  assert.match(first?.textContent ?? '', /Waiting 24 h/);
  assert.match(second?.textContent ?? '', /Waiting 3 h/);
  assert.match(first?.textContent ?? '', /Updated 1 h ago/, 'updated and open read in hours under three days');
  cleanup();
});

test('each sub-tab pages on its own: Next in one does not change another', async () => {
  const rows = [...many(30), ...Array.from({ length: 30 }, (_, i) => pr(100 + i, { unresolved: 1 }))];
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data(rows), loaded: true }, drafts: drafts([]) });
  press(root, 'next');
  assert.equal(pagerText(root), 'Page 2 of 2 (26\u201330 of 30)');
  pick(root, 'threads');
  assert.equal(pagerText(root), 'Page 1 of 2 (1\u201325 of 30)');
  cleanup();
});

test('a draft on a PR someone else already approved still shows, with its card, under the drafts not listed above', async () => {
  const model = { data: { ...data([pr(1)]), approvedKeys: ['acme/app#9'] }, loaded: true };
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model, drafts: drafts([draft(9)]) });
  assert.ok(root.querySelector('h3.orphans'));
  assert.match(root.textContent ?? '', /acme\/app#9 by/);
  cleanup();
});

test('a waiting draft outside the open sub-tab is announced with a jump to it', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1)]), loaded: true }, drafts: drafts([draft(1)]) });
  const note = root.querySelector('[data-note="waiting-drafts"]');
  assert.match(note?.textContent ?? '', /1 drafted review waits for your Approve in the In review tab/);
  (note?.querySelector('button') as HTMLButtonElement).click();
  assert.match(root.querySelector('li.pr')?.textContent ?? '', /Draft ready/);
  assert.equal(root.querySelector('[data-note="waiting-drafts"]'), null);
  cleanup();
});

test('focusDraft opens the sub-tab that holds that draft, once', async () => {
  const { root, cleanup } = await mount<El & { focusDraft: string | null }>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1), pr(2)]), loaded: true }, drafts: drafts([draft(1)]), focusDraft: 'dr-00000001' });
  assert.equal(root.querySelector('button.tab[aria-selected="true"]')?.getAttribute('data-tab'), 'in-review');
  pick(root, 'ready');
  assert.equal(root.querySelector('button.tab[aria-selected="true"]')?.getAttribute('data-tab'), 'ready', 'the person can still leave it');
  cleanup();
});

test('a queued draft shows its Approve button on the tab, in the sub-tab the Home cue opens, and for a PR no longer listed', async () => {
  await import('../src/draft-queue.ts');
  const rows = [draft(1, { severity: 'review', review: { event: 'APPROVE', compliment: 'The ID validation before anything goes into a URL is careful.', comments: [] }, text: 'The ID validation before anything goes into a URL is careful.' }), draft(9)];
  const noop = () => {};
  const real: OthersDrafts = { rows, queue: (match, empty, quiet, authorOf) => {
    const q = document.createElement('draft-queue') as unknown as HTMLElement & Record<string, unknown>;
    q.sources = ['review']; q.emptyText = empty; q.match = match; q.quiet = quiet; q.authorOf = authorOf;
    q.actions = { startEdit: noop, startReject: noop, cancel: noop, setBuffer: noop, setComment: noop, saveEdit: noop, approve: noop, reject: noop };
    q.model = { data: { generatedAt: '2026-10-15T12:00:00Z', drafts: rows }, loaded: true, ui: {} };
    return q;
  } };
  const { root, cleanup } = await mount<El & { focusDraft: string | null }>('../src/others-prs.ts', 'others-prs', { model: { data: { ...data([pr(1)]), approvedKeys: ['acme/app#9'] }, loaded: true }, drafts: real, focusDraft: 'dr-00000001' });
  const approves = (): string[] => [...root.querySelectorAll('draft-queue')].flatMap((q) => [...(q.shadowRoot?.querySelectorAll('li.draft button.primary') ?? [])].map((b) => `${q.shadowRoot?.querySelector('li.draft')?.getAttribute('data-id')}:${b.textContent}`));
  assert.deepEqual(approves().sort(), ['dr-00000001:Approve', 'dr-00000009:Approve']);
  cleanup();
});

test('the waiting-drafts note names the sub-tab classify really puts the PR in, including Stale', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { updatedAt: '2026-09-01T00:00:00Z', staleWhy: 'no activity for 40 days' } as Partial<OthersPrRow>)]), loaded: true }, drafts: drafts([draft(1)]) });
  const note = root.querySelector('[data-note="waiting-drafts"]');
  const tabName = (note?.textContent ?? '').match(/in the (.+?) tab/)?.[1];
  (note?.querySelector('button') as HTMLButtonElement).click();
  assert.equal(root.querySelector('button.tab[aria-selected="true"]')?.textContent?.replace(/ \(\d+\)$/, ''), tabName);
  assert.match(root.querySelector('li.pr')?.textContent ?? '', /Draft ready/);
  cleanup();
});

const HEAD = 'a'.repeat(40);
const settle = (): Promise<void> => new Promise((ok) => { setTimeout(ok, 0); });
const click = (root: ParentNode, sel: string): void => { (root.querySelector(sel) as HTMLElement).click(); };

test('Ignore on a row asks for that PR at its head; a refusal is shown on the row and the PR stays', async () => {
  const calls: string[] = [];
  const actions: OthersActions = { run: async (op, p) => { calls.push(`${op} ${p.repo}#${p.number} ${p.headSha}`); return 'The PR has new commits since this page was drawn. Reload and try again.'; } };
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD })]), loaded: true }, drafts: drafts([]), actions });
  click(root, 'li.pr button[aria-label="Ignore acme/app#1"]');
  await settle();
  assert.deepEqual(calls, [`ignore acme/app#1 ${HEAD}`]);
  assert.match(root.querySelector('li.pr .status.bad')?.textContent ?? '', /new commits since this page was drawn/);
  assert.equal(numbers(root).join(), '1');
  cleanup();
});

test('Ignore is off, with the reason said, when the list has not recorded the PR\'s commit', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1)]), loaded: true }, drafts: drafts([]) });
  assert.equal((root.querySelector('button[aria-label="Ignore acme/app#1"]') as HTMLButtonElement).disabled, true);
  assert.match(root.querySelector('li.pr')?.textContent ?? '', /Cannot be ignored until the list records its latest commit/);
  cleanup();
});

test('an ignored PR leaves the sub-tab lists and counts and shows under "Ignored (n)", where Un-ignore asks for it', async () => {
  const calls: string[] = [];
  const actions: OthersActions = { run: async (op, p) => { calls.push(`${op} ${p.number}`); return null; } };
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD, ignored: 'ignored' }), pr(2, { headSha: HEAD })]), loaded: true }, drafts: drafts([]), actions });
  assert.deepEqual(numbers(root).filter((n) => n === 2), [2]);
  assert.match(root.querySelector('button.tab[data-tab="ready"]')?.textContent ?? '', /Ready for approval \(1\)/);
  assert.equal(root.querySelector('ul[aria-label="Open teammate PRs"] li[data-pr="acme/app#1"]'), null, 'not in the sub-tab list');
  assert.equal(root.querySelector('details.ignored summary')?.textContent, 'Ignored (1)');
  click(root, 'details.ignored button[aria-label="Un-ignore acme/app#1"]');
  await settle();
  assert.deepEqual(calls, ['unignore 1']);
  assert.equal(root.querySelector('p[data-said]')?.textContent, 'acme/app#1 is back in the list.');
  cleanup();
});

test('with nothing ignored there is no Ignored toggle', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD })]), loaded: true }, drafts: drafts([]) });
  assert.equal(root.querySelector('details.ignored'), null);
  cleanup();
});

test('a PR with new commits since it was ignored is back in its list, with a chip that says so', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD, ignored: 'new-commits' })]), loaded: true }, drafts: drafts([]) });
  assert.equal(numbers(root).join(), '1');
  assert.match(root.querySelector('li.pr')?.textContent ?? '', /New commits since you ignored/);
  assert.equal(root.querySelector('details.ignored'), null);
  cleanup();
});

test('a draft on an ignored PR is not hidden: it shows under "Drafts on PRs not listed above"', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD, ignored: 'ignored' })]), loaded: true }, drafts: drafts([draft(1)]) });
  assert.match(root.querySelector('h3.orphans')?.textContent ?? '', /not listed above/);
  assert.match(root.querySelector('.queue')?.textContent ?? '', /acme\/app#1/);
  cleanup();
});

test('a hands-off row says why and offers Review anyway, which asks for that PR; once asked it says the draft comes after the next run', async () => {
  const calls: string[] = [];
  const actions: OthersActions = { run: async (op, p) => { calls.push(`${op} ${p.number}`); return null; } };
  const why = 'acme/app is in hands_off_repos: its owner (lee-fake) decides these.';
  const { el, root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD, handsOff: true, handsOffWhy: why })]), loaded: true }, drafts: drafts([]), actions });
  assert.equal(root.querySelector('[data-note="hands-off"]')?.textContent, why);
  click(root, 'button[aria-label="Review acme/app#1 anyway"]');
  await settle();
  assert.deepEqual(calls, ['review-anyway 1']);
  el.model = { data: data([pr(1, { headSha: HEAD, handsOff: true, handsOffWhy: why, reviewRequested: true })]), loaded: true };
  assert.equal(root.querySelector('button[aria-label="Review acme/app#1 anyway"]'), null);
  assert.match(root.querySelector('[data-note="review-requested"]')?.textContent ?? '', /draft appears after the next review run/);
  cleanup();
});

test('once a hands-off PR has a waiting draft, Review anyway goes and the draft card carries the actions', async () => {
  const { root, cleanup } = await mount<El>('../src/others-prs.ts', 'others-prs', { model: { data: data([pr(1, { headSha: HEAD, handsOff: true })]), loaded: true }, drafts: drafts([draft(1)]) });
  pick(root, 'in-review');
  assert.equal(root.querySelector('button[aria-label="Review acme/app#1 anyway"]'), null);
  assert.equal(root.querySelector('[data-note="hands-off"]'), null);
  assert.ok(root.querySelector('.queue'));
  cleanup();
});
