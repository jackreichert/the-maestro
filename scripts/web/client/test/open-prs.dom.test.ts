// Run: node --test scripts/web/client/test/open-prs.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { OpenPrRow, OpenPrsData } from '../src/types.ts';
import type { OpenPrsModel } from '../src/open-prs-store.ts';

installDom();
type El = HTMLElement & { model: OpenPrsModel; tz: string; onRefresh: () => void };

const pr = (over: Partial<OpenPrRow> = {}): OpenPrRow => ({
  number: 7, title: 'Add the thing', url: 'https://github.com/acme/widgets/pull/7', base: 'develop', head: 'feat/x-1', isDraft: true,
  review: 'none', unresolved: 0, mergeable: 'mergeable', twins: [], ageDays: 3, ...over,
});
const data = (over: Partial<OpenPrsData> = {}): OpenPrsData => ({
  generatedAt: '2026-10-12T15:00:00Z', prData: { fetchedAt: '2026-10-12T14:56:00Z', stale: false }, total: 3,
  groups: [
    { id: 'team', label: 'Team repos', count: 2, repos: [{ repo: 'acme/widgets', count: 2, prs: [pr({ sides: { develop: { number: 7, url: 'https://github.com/acme/widgets/pull/7' } } }), pr({ number: 9, url: 'https://github.com/acme/widgets/pull/9', base: 'staging', twins: [7], sides: { develop: { number: 7, url: 'https://github.com/acme/widgets/pull/7' }, staging: { number: 9, url: 'https://github.com/acme/widgets/pull/9' } }, unresolved: 2, mergeable: 'conflicting', review: 'changes-requested', isDraft: false, ticket: { label: 'AB-1', url: 'https://acme.atlassian.net/browse/AB-1' } })] }] },
    { id: 'self-review', label: 'Self-review repos', count: 1, repos: [{ repo: 'me/tool', count: 1, prs: [pr({ number: 3, url: 'https://github.com/me/tool/pull/3', base: 'main' })] }] },
  ],
  ...over,
});
const model = (over: Partial<OpenPrsModel> = {}): OpenPrsModel => ({ data: data(), loaded: true, refresh: { kind: 'idle' }, ...over });
const text = (root: ParentNode): string => root.textContent ?? '';

test('PRs are grouped by whose move, then by repo', async () => {
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model() });
  const heads = [...root.querySelectorAll('h2, h3')].map((e) => e.textContent?.replace(/\s+/g, ' ').trim());
  assert.ok(heads.some((h) => h?.startsWith('Your move')));
  assert.ok(heads.some((h) => h?.startsWith('Drafts')));
  assert.ok(heads.includes('widgets 1 PR') || heads.some((h) => h?.startsWith('widgets')));
  assert.equal(root.querySelectorAll('li.pr').length, 3);
  cleanup();
});

test('each PR is its own row, with its base, gates and the twin named beside it', async () => {
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model() });
  const rows = [...root.querySelectorAll('li.pr')];
  const staging = rows.find((r) => r.textContent?.includes('#9'));
  assert.ok(staging);
  const line = staging.textContent?.replace(/\s+/g, ' ') ?? '';
  assert.match(line, /→ staging/);
  assert.match(line, /twin of #7/);
  assert.match(line, /Changes/);
  assert.match(line, /Conflicts/);
  assert.match(line, /3 d/);
  assert.equal(staging.querySelector('a[href$="/pull/9"]')?.textContent, 'Add the thing');
  assert.equal(staging.querySelector('a[href$="AB-1"]')?.textContent, 'AB-1');
  assert.ok(rows.some((r) => /→ develop/.test(r.textContent ?? '')));
  cleanup();
});

test('a staging PR with no develop twin still names its base', async () => {
  const only = data({
    total: 1,
    groups: [{ id: 'team', label: 'Team repos', count: 1, repos: [{ repo: 'acme/widgets', count: 1, prs: [pr({ number: 9, base: 'staging', url: 'https://github.com/acme/widgets/pull/9', isDraft: false, sides: { staging: { number: 9, url: 'https://github.com/acme/widgets/pull/9' } } })] }] }],
  });
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { model: model({ data: only }) });
  assert.equal(root.querySelectorAll('li.pr').length, 1);
  assert.match(text(root), /→ staging/);
  cleanup();
});

test('a PR whose URL is unsafe is text, never a link', async () => {
  const bad = data({ groups: [{ id: 'team', label: 'Team repos', count: 1, repos: [{ repo: 'a/b', count: 1, prs: [pr({ url: 'javascript:alert(1)' })] }] }], total: 1 });
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { model: model({ data: bad }) });
  assert.equal(root.querySelectorAll('a').length, 0);
  assert.match(text(root), /#7/);
  cleanup();
});

test('the freshness line says when the PR data was read, and flags stale data and a GitHub failure', async () => {
  const fresh = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model() });
  assert.match(text(fresh.root), /PR data 2:56 pm \(4 min ago\)/);
  assert.doesNotMatch(text(fresh.root), /Stale/);
  fresh.cleanup();
  const stale = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: data({ prData: { fetchedAt: '2026-10-12T14:00:00Z', stale: true } }) }) });
  assert.match(text(stale.root), /Stale\. Press Refresh\./);
  stale.cleanup();
  const failed = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: data({ prData: { fetchedAt: '2026-10-12T14:00:00Z', stale: true, failure: 'rate limit' } }) }) });
  assert.match(text(failed.root), /GitHub could not be read \(rate limit\); showing the last data\./);
  failed.cleanup();
});

test('empty, loading and unavailable are each said in words', async () => {
  const empty = await mount<El>('../src/open-prs.ts', 'open-prs', { model: model({ data: data({ total: 0, groups: [] }) }) });
  assert.match(text(empty.root), /No open PRs\./);
  empty.cleanup();
  const loading = await mount<El>('../src/open-prs.ts', 'open-prs', { model: model({ data: null, loaded: false }) });
  assert.match(text(loading.root), /Loading PR data/);
  loading.cleanup();
  const gone = await mount<El>('../src/open-prs.ts', 'open-prs', { model: model({ data: null }) });
  assert.match(text(gone.root), /not available from this page/);
  gone.cleanup();
});

test('Refresh calls onRefresh; while refreshing it says so, is aria-disabled and ignores clicks', async () => {
  const { el, root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { model: model() });
  let presses = 0;
  el.onRefresh = () => { presses += 1; };
  const button = root.querySelector<HTMLButtonElement>('button.refresh');
  assert.ok(button);
  assert.equal(button.textContent, 'Refresh');
  button.click();
  assert.equal(presses, 1);
  el.model = model({ refresh: { kind: 'running' } });
  assert.equal(button.textContent, 'Refreshing...');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.match(text(root), /Refreshing the PR data/);
  button.click();
  button.click();
  assert.equal(presses, 1, 'clicks while refreshing do nothing');
  cleanup();
});

test('a finished refresh updates the table and the freshness line in place; failures and the lock are shown', async () => {
  const { el, root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model() });
  const button = root.querySelector('button.refresh');
  el.model = model({ refresh: { kind: 'done' }, data: data({ total: 1, prData: { fetchedAt: '2026-10-12T14:59:00Z', stale: false }, groups: [{ id: 'team', label: 'Team repos', count: 1, repos: [{ repo: 'acme/widgets', count: 1, prs: [pr()] }] }] }) });
  assert.equal(root.querySelector('button.refresh'), button, 'the button is the same node, so it keeps focus');
  assert.equal(root.querySelectorAll('li.pr').length, 1);
  assert.match(text(root), /Refreshed\./);
  assert.match(text(root), /PR data 2:59 pm/);
  assert.equal(button?.getAttribute('aria-disabled'), 'false');
  el.model = model({ refresh: { kind: 'failed', message: 'GitHub could not be read (rate limit).' } });
  assert.match(text(root), /GitHub could not be read \(rate limit\)\./);
  assert.ok(root.querySelector('.state.failed'));
  el.model = model({ refresh: { kind: 'locked', message: 'Another refresh is already running.' } });
  assert.ok(root.querySelector('.state.locked'));
  assert.match(text(root), /already running/);
  cleanup();
});

test('ready-to-merge PRs are pinned in the first band with a count that filters, and an approved PR lists its approvers in a folded disclosure', async () => {
  const ready = pr({ number: 21, isDraft: false, review: 'approved', approvers: ['fake-a', 'fake-b'], title: 'Ready one' });
  const d = data({ total: 2, groups: [{ id: 'team', label: 'Team repos', count: 2, repos: [{ repo: 'acme/widgets', count: 2, prs: [pr({ number: 22, isDraft: false, title: 'Clean, unreviewed' }), ready] }] }] });
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: d }) });
  const bands = [...root.querySelectorAll('section.band')];
  assert.equal(bands[0]?.id, 'ready', 'pinned first');
  assert.match(bands[0]?.querySelector('h2')?.textContent ?? '', /Ready to merge\s*1/);
  assert.equal(bands[0]?.querySelectorAll('li.pr').length, 1);
  const toggle = root.querySelector<HTMLButtonElement>('button[data-move=ready]')!;
  assert.match(toggle.textContent ?? '', /1 ready to merge/);
  const details = bands[0]!.querySelector('details.appr')!;
  assert.equal(details.hasAttribute('open'), false, 'collapsed by default');
  assert.equal(details.querySelector('summary')?.textContent, 'Approved · 2');
  assert.deepEqual([...details.querySelectorAll('li')].map((x) => x.textContent), ['fake-a', 'fake-b']);
  assert.equal(root.querySelectorAll('details.appr').length, 1, 'an unapproved PR has no disclosure');
  toggle.click();
  assert.deepEqual([...root.querySelectorAll('section.band')].map((b) => b.id), ['ready'], 'the toggle shows only ready PRs');
  cleanup();
});

test('a staging PR waiting on its develop twin names it, linked, and is not in the ready band; one with no twin says so', async () => {
  const waits = pr({ number: 31, isDraft: false, review: 'approved', base: 'staging', title: 'Waits', waitsOnDevelop: { number: 30, url: 'https://github.com/acme/widgets/pull/30' } });
  const lost = pr({ number: 32, isDraft: false, review: 'approved', base: 'staging', title: 'Lost twin', waitsOnDevelop: {} });
  const free = pr({ number: 33, isDraft: false, review: 'approved', base: 'staging', title: 'Free' });
  const d = data({ total: 3, groups: [{ id: 'team', label: 'Team repos', count: 3, repos: [{ repo: 'acme/widgets', count: 3, prs: [waits, lost, free] }] }] });
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: d }) });
  const ready = root.querySelector('section#ready');
  assert.match(text(ready!), /Free/);
  assert.doesNotMatch(text(ready!), /Waits|Lost twin/);
  const link = [...root.querySelectorAll('a.wait')].find((a) => /#30/.test(a.textContent ?? ''));
  assert.equal(link?.textContent, 'Waits on develop twin #30');
  assert.equal(link?.getAttribute('href'), 'https://github.com/acme/widgets/pull/30');
  assert.match(text(root), /Waits on develop twin: none found/);
  cleanup();
});

const U = 'https://github.com/acme/widgets/pull';
const pairRows = (devOver: Partial<OpenPrRow> = {}, stgOver: Partial<OpenPrRow> = {}): OpenPrRow[] => [
  pr({ number: 7, url: `${U}/7`, title: 'Add the thing', isDraft: false, sides: { develop: { number: 7, url: `${U}/7` }, staging: { number: 9, url: `${U}/9` } }, twins: [9], ...devOver }),
  pr({ number: 9, url: `${U}/9`, title: 'Add the thing (staging)', base: 'staging', isDraft: false, sides: { develop: { number: 7, url: `${U}/7` }, staging: { number: 9, url: `${U}/9` } }, twins: [7], waitsOnDevelop: { number: 7, url: `${U}/7` }, ...stgOver }),
];
const one = (prs: OpenPrRow[]): OpenPrsData => data({ total: prs.length, groups: [{ id: 'team', label: 'Team repos', count: prs.length, repos: [{ repo: 'acme/widgets', count: prs.length, prs }] }] });

test('a develop PR and its open staging twin are one card with a lane each, counted as two PRs in one band', async () => {
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: one(pairRows({ unresolved: 1 }, { ci: 'FAILURE' })) }) });
  const cards = [...root.querySelectorAll('li.pr')];
  assert.equal(cards.length, 1);
  assert.ok(cards[0]?.classList.contains('pair'));
  const lanes = [...cards[0]!.querySelectorAll('.lane')];
  assert.deepEqual(lanes.map((l) => l.querySelector('.lane-h a')?.textContent), ['Develop #7', 'Staging #9']);
  assert.deepEqual(lanes.map((l) => l.querySelector('.lane-h a')?.getAttribute('href')), [`${U}/7`, `${U}/9`]);
  assert.match(lanes[0]?.textContent ?? '', /→ develop/);
  assert.match(lanes[1]?.textContent ?? '', /→ staging/);
  assert.match(lanes[0]?.textContent ?? '', /Thread/, 'each lane keeps its own gates');
  assert.match(lanes[1]?.textContent ?? '', /Failing/);
  assert.equal(cards[0]?.querySelectorAll('a.title').length, 1, 'the title is drawn once');
  assert.match(text(root), /widgets 2 PRs/);
  assert.equal(root.querySelectorAll('section.band').length, 4);
  cleanup();
});

test('a staging PR whose develop twin merged keeps the develop PR in its card, marked Merged, with no gates of its own', async () => {
  const stg = pr({ number: 9, url: `${U}/9`, base: 'staging', isDraft: false, review: 'approved', sides: { develop: { number: 7, url: `${U}/7`, merged: true }, staging: { number: 9, url: `${U}/9` } } });
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: one([stg]) }) });
  const cards = [...root.querySelectorAll('li.pr')];
  assert.equal(cards.length, 1);
  const merged = cards[0]!.querySelector('.lane.merged');
  assert.ok(merged);
  assert.equal(merged.querySelector('a')?.textContent, 'Develop #7');
  assert.equal(merged.querySelector('a')?.getAttribute('href'), `${U}/7`);
  assert.match(merged.textContent ?? '', /Merged/);
  assert.equal(merged.querySelectorAll('.gate').length, 0);
  assert.equal(cards[0]!.querySelectorAll('.lane:not(.merged) .gate').length, 4);
  assert.match(text(root.querySelector('section#ready')!), /Staging #9/, 'a merged develop twin frees the staging PR for the ready band');
  cleanup();
});

test('a pair bands by its develop PR, and a search or lens that hits either side keeps the whole pair', async () => {
  const rows = pairRows({ isDraft: true }, { ci: 'FAILURE', title: 'Zebra rollout (staging)' });
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: one(rows) }) });
  assert.equal(root.querySelector('section#drafts li.pair') !== null, true, 'the draft develop PR decides the band');
  const search = root.querySelector('input[type=search]') as HTMLInputElement;
  search.value = 'zebra';
  search.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
  assert.equal(root.querySelectorAll('li.pair .lane').length, 2, 'only the staging title matches, both lanes stay');
  assert.match(text(root), /2 PRs shown/);
  cleanup();
});

test('an unpaired PR, a pair whose sides disagree, and a stacked pair draw as before', async () => {
  const lone = pr({ number: 5, url: `${U}/5`, sides: { develop: { number: 5, url: `${U}/5` } } });
  const askew = pairRows({}, {});
  askew[1] = { ...askew[1]!, sides: { develop: { number: 99, url: `${U}/99` }, staging: { number: 9, url: `${U}/9` } } };
  const { root, cleanup } = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: one([lone, ...askew]) }) });
  assert.equal(root.querySelectorAll('li.pair').length, 0);
  assert.equal(root.querySelectorAll('li.pr').length, 3);
  cleanup();
  const kid = pr({ number: 12, url: `${U}/12`, base: 'feat/x', stackedOn: 9, isDraft: false });
  const stacked = await mount<El>('../src/open-prs.ts', 'open-prs', { tz: 'UTC', model: model({ data: one([...pairRows(), kid]) }) });
  const li = [...stacked.root.querySelectorAll('li.pr')];
  assert.equal(li.length, 2);
  assert.ok(li[1]?.classList.contains('child'), 'a PR stacked on either side nests under the pair');
  stacked.cleanup();
});
