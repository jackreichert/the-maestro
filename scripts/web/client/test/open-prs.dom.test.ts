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
