// Run: node --test scripts/podium-slim.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const { buildPage, generate, SETTINGS_HOOK, SETTINGS_HOOK_END } = await import('./podium-slim.ts');
import type { PageInput } from './podium-slim.ts';
import type { SnapshotPr } from './prs-snapshot.ts';
const { CONTAINER_PROJECT } = await import('./local-config.ts');

const NOW = new Date('2026-11-03T15:00:00Z');
const KEY = '\\b[A-Z][A-Z0-9]+-\\d+\\b';

const input = (over: Partial<PageInput> = {}): PageInput => ({
  now: NOW, keyPattern: KEY, trackerUrlBase: '', asks: [], tracker: null, prs: null, ...over,
});

test('empty state: three headings, each says nothing is open, and the settings hook is present', () => {
  const page = buildPage(input());
  const heads = page.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(heads, ['## Open questions', '## Jira in flight', '## PRs in flight']);
  assert.match(page, /Nothing is waiting on you\./);
  assert.match(page, /No tracker snapshot yet/);
  assert.match(page, /No PR snapshot yet/);
  assert.ok(page.includes(SETTINGS_HOOK) && page.includes(SETTINGS_HOOK_END), 'a marked place for the settings section');
  assert.ok(page.indexOf(SETTINGS_HOOK) > page.indexOf('## PRs in flight'), 'the hook comes after the three lists');
});

test('open questions carry the recommendation, the stakes and a link', () => {
  const page = buildPage(input({
    asks: [
      { id: 'q1', text: 'Ship the fake widget now?', recommend: 'Ship it', blocked: 'The sample release', links: ['Spec: https://example.com/spec'] },
      { id: 'q2', text: 'Rename the sample stream?' },
    ],
  }));
  assert.match(page, /\*\*q1\*\* Ship the fake widget now\?/);
  assert.match(page, /Recommend: Ship it/);
  assert.match(page, /Stakes: The sample release/);
  assert.match(page, /\[Spec\]\(https:\/\/example\.com\/spec\)/);
  assert.match(page, /\*\*q2\*\* Rename the sample stream\?\n\s+- Recommend: none given/);
});

test('Jira in flight lists tickets that are not done, with the linked PR, and reads no live tracker', () => {
  const page = buildPage(input({
    trackerUrlBase: 'https://tracker.example.com/browse/',
    tracker: { fetchedAt: '2026-11-03T14:00:00Z', source: 'jira', items: [
      { key: 'DEMO-1', title: 'Sample ticket', status: 'In Progress', priority: '', labels: [] },
      { key: 'DEMO-2', title: 'Finished ticket', status: 'Done', priority: '', labels: [] },
      { key: 'DEMO-3', title: 'No PR yet', status: 'To Do', priority: '', labels: [] },
    ] },
    prs: { takenAt: NOW.toISOString(), prs: [pr(7, { title: 'feat: DEMO-1 sample change', url: 'https://example.com/o/r/pull/7' })] },
  }));
  const jira = section(page, 'Jira in flight');
  assert.match(jira, /\[DEMO-1\]\(https:\/\/tracker\.example\.com\/browse\/DEMO-1\).*In Progress.*\[o\/r#7\]/);
  assert.match(jira, /DEMO-3.*To Do.*no PR/);
  assert.doesNotMatch(jira, /DEMO-2/);
  assert.match(jira, /snapshot from 2026-11-03 09:00 ET/);
});

test('PRs in flight show draft or ready, checks, unresolved threads, mergeable and review state', () => {
  const page = buildPage(input({ prs: { takenAt: NOW.toISOString(), prs: [
    pr(1, { isDraft: true, ci: 'PENDING', mergeable: 'UNKNOWN', reviewDecision: '' }),
    pr(2, { ci: 'SUCCESS', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', threads: [
      { id: 'a', isResolved: false, isOutdated: false, author: 'fake-reviewer' },
      { id: 'b', isResolved: true, isOutdated: false, author: 'fake-reviewer' },
      { id: 'c', isResolved: false, isOutdated: true, author: 'fake-reviewer' },
    ] }),
  ] } }));
  const prs = section(page, 'PRs in flight');
  assert.match(prs, /o\/r#1.*draft.*checks pending.*0 open threads.*mergeable unknown.*no review yet/);
  assert.match(prs, /o\/r#2.*ready.*checks passing.*1 open thread[^s].*mergeable.*approved/);
});

test('a cell from a snapshot cannot break the markdown line', () => {
  const page = buildPage(input({ prs: { takenAt: NOW.toISOString(), prs: [pr(3, { title: 'bad\n## Injected | [x](y)' })] } }));
  assert.equal(page.split('\n').filter((l) => l.startsWith('## ')).length, 3);
});

test('generate reads the stores, writes the page once, and renders in under 5 seconds', () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-slim-'));
  const journal = join(root, 'ledger', 'Projects', CONTAINER_PROJECT, 'Journal');
  mkdirSync(journal, { recursive: true });
  const status = join(root, 'status');
  mkdirSync(status, { recursive: true });
  writeFileSync(join(journal, 'ledger.jsonl'), [
    { id: 'a1', kind: 'question', text: 'Pick the sample colour?', recommend: 'Blue', blocked: 'The demo', date: '2026-11-02' },
    { id: 'a2', kind: 'question', text: 'Answered already', date: '2026-11-02' },
    { id: 'r1', kind: 'resolved', closes: 'a2', text: 'done', date: '2026-11-02' },
    { id: 'w1', kind: 'wip', text: 'Not an ask', date: '2026-11-02' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(journal, 'prs-current.json'), JSON.stringify({ takenAt: NOW.toISOString(), prs: [pr(5, {})] }));
  writeFileSync(join(status, 'tracker-items.json'), JSON.stringify({ fetchedAt: NOW.toISOString(), source: 'jira', items: [{ key: 'DEMO-9', title: 'Sample', status: 'To Do', priority: '', labels: [] }] }));
  const out = join(root, 'out', 'Podium-Slim.md');
  const opts = { ledger: join(root, 'ledger'), project: CONTAINER_PROJECT, statusDir: status, out, html: join(root, 'out', 'podium.html'), now: NOW, keyPattern: KEY, trackerUrlBase: '' };
  const t0 = performance.now();
  const r = generate(opts);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `rendered in ${Math.round(ms)} ms`);
  const page = readFileSync(out, 'utf8');
  assert.match(page, /Pick the sample colour\?/);
  assert.doesNotMatch(page, /Answered already|Not an ask/);
  assert.match(page, /DEMO-9/);
  assert.match(page, /o\/r#5/);
  assert.equal(r.wrote, true);
  assert.match(readFileSync(opts.html, 'utf8'), /<h2>Open questions<\/h2>/);
  assert.equal(generate(opts).wrote, false, 'an unchanged page is not rewritten');
});

test('generate with no stores renders the empty state and does not throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-slim-empty-'));
  const out = join(root, 'p.md');
  generate({ ledger: root, project: CONTAINER_PROJECT, statusDir: join(root, 'none'), out, html: '', now: NOW, keyPattern: KEY, trackerUrlBase: '' });
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /Nothing is waiting on you\./);
});

function section(page: string, name: string): string {
  const from = page.indexOf(`## ${name}`);
  const rest = page.slice(from + 3);
  const next = rest.search(/\n## |\n<!--/);
  return next < 0 ? rest : rest.slice(0, next);
}

function pr(n: number, over: Partial<SnapshotPr>): SnapshotPr {
  return {
    key: `o/r#${n}`, repo: 'o/r', number: n, title: `feat: sample ${n}`, url: `https://example.com/o/r/pull/${n}`, isDraft: false,
    headRefName: `feat/sample-${n}`, baseRefName: 'main', updatedAt: NOW.toISOString(), reviewDecision: '', mergeable: 'MERGEABLE',
    ci: 'SUCCESS', threadsComplete: true, reviewers: [], reviews: [], threads: [], commentTotal: 0, ...over,
  };
}
