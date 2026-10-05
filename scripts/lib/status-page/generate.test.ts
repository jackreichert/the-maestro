// Run: node --test scripts/lib/status-page/generate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, loadPrs } from './generate.ts';
import type { GenerateDeps, RawPr } from './generate.ts';
import { writePriorities } from './priorities.ts';
import type { PageConfig } from './render.ts';

const NOW = new Date('2026-10-05T15:00:00Z');
const CONFIG: PageConfig = {
  streams: ['Alpha'], repoStreams: { 'acme-widgets': 'Alpha', gadgets: 'Beta' }, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/',
  ticketNotePath: 'Projects/{prefix}/Tickets/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'America/New_York',
};
const raw = (number: number, repo: string, over: Partial<RawPr> = {}): RawPr => ({
  number, title: `feat: thing ${number} FAKE-${number}`, url: `https://example.test/${repo}/pull/${number}`, isDraft: true, baseRefName: 'develop', headRefName: `feat/FAKE-${number}`,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, repository: { nameWithOwner: `org/${repo}` },
  reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
});
const board = {
  status: {
    inflight: [{ id: 'aa11', date: '2026-10-05', text: 'building a thing', stream: 'Alpha' }],
    blocked: [], done: [{ id: 'dd44', date: '2026-10-05', text: 'shipped' }],
    awaiting: [
      { id: 'bb22', date: '2026-10-05', text: 'Merge widgets #12 now? See FAKE-12', stream: 'Alpha' },
      { id: 'cc33', date: '2026-09-25', text: 'old question | with a pipe', stream: 'Gamma' },
    ],
  },
  triage: { items: [{ id: 'bb22', date: '2026-10-05', text: '', ticket: 'proj-7' }] },
};
const deps = (prs: RawPr[], over: Partial<GenerateDeps> = {}): GenerateDeps => ({
  journal: (sub) => board[sub], fetchPrs: () => prs, sleep: () => {}, now: () => NOW, ...over,
});
const opts = (statusDir: string, over = {}) => ({ statusDir, dryRun: false, snapshot: false, command: 'journal.ts status-page', config: CONFIG, ...over });
const dir = (): string => mkdtempSync(join(tmpdir(), 'sp-'));

test('loadPrs picks a stream from an override, then the repo map, then other', () => {
  const prs = loadPrs([raw(1, 'acme-widgets'), raw(2, 'gadgets'), raw(3, 'unmapped'), raw(4, 'unmapped')], { 'unmapped#4': 'Alpha', 'gadgets#2': 'Gamma' }, CONFIG.repoStreams);
  assert.deepEqual(prs.map((p) => p.stream), ['Alpha', 'Gamma', 'other', 'Alpha']);
  assert.equal(prs[0]?.unresolved, 1);
});

test('writes NOW.md with the priorities block first, short ask cells, and links and an answer stub under the table', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'Get widgets out', stream: 'Alpha' }, { text: 'Unmapped goal' }]);
  const r = generate(opts(d), deps([raw(12, 'acme-widgets')]));
  assert.deepEqual(r.written, [join(d, 'NOW.md')]);
  const page = readFileSync(join(d, 'NOW.md'), 'utf8');
  assert.equal(page, r.page);
  const lines = page.split('\n');
  assert.equal(lines[lines.indexOf('# Status now') + 2], "## Today's priorities");
  assert.match(page, /1\. Get widgets out _\[Alpha: awaiting 1 · in flight 1 · open PRs 1\]_\n2\. Unmapped goal\n/);
  assert.match(page, /\| `bb22` \| Merge widgets #12 now\? See FAKE-12 \| proj-7 \| #12 → develop \|/, 'cells are short text, no URLs');
  assert.doesNotMatch(page.split('## PR board')[0] ?? '', /\| .*https?:\/\//, 'no URL inside an ask table row');
  assert.match(page, /- \[ \] `bb22` \[#12 → develop\]\(https:\/\/example\.test\/acme-widgets\/pull\/12\) · \[FAKE-12\]\(https:\/\/tracker\.test\/browse\/FAKE-12\) · \[proj-7\]\(obsidian:\/\/open\?vault=Vault&file=Projects%2Fproj%2FTickets%2Fproj-7\)\n  > answer: \n/);
  assert.match(page, /ask `cc33` is 10 days old/);
  assert.match(page, /### Gamma \(1\)/, 'a stream only the ledger knows still gets a section');
  assert.match(page, /old question \\\| with a pipe/, 'a pipe in text does not break the table');
});

test('priorities missing or from another day render the banner, never yesterday\'s list', () => {
  const d = dir();
  const banner = '**Priorities not set for today — orchestrator will ask**';
  assert.match(generate(opts(d, { dryRun: true }), deps([])).page, new RegExp(`## Today's priorities\\n\\n${banner.replace(/[*]/g, '\\*')}`));
  writePriorities(d, '2026-10-04', [{ text: 'yesterday' }]);
  const page = generate(opts(d, { dryRun: true }), deps([])).page;
  assert.match(page, /Priorities not set for today/);
  assert.doesNotMatch(page, /yesterday/);
});

test('"today" follows the configured zone: 01:00 UTC on the 6th is still the 5th in New York', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'evening list' }]);
  const late = deps([], { now: () => new Date('2026-10-06T01:00:00Z') });
  assert.match(generate(opts(d, { dryRun: true }), late).page, /1\. evening list/);
});

test('--dry-run writes nothing; --snapshot adds the dated copy', () => {
  const d = dir();
  const dry = generate(opts(d, { dryRun: true }), deps([]));
  assert.deepEqual(dry.written, []);
  assert.equal(existsSync(join(d, 'NOW.md')), false);
  const snap = generate(opts(d, { snapshot: true }), deps([]));
  assert.deepEqual(snap.written, [join(d, 'NOW.md'), join(d, '2026-10-05.md')]);
  assert.equal(readFileSync(join(d, '2026-10-05.md'), 'utf8'), snap.page);
});

test('ticket-map.json and stream-overrides.json beside the page are read; invalid JSON stops before any write', () => {
  const d = dir();
  writeFileSync(join(d, 'ticket-map.json'), JSON.stringify({ 'proj-9': ['cc33'] }));
  writeFileSync(join(d, 'stream-overrides.json'), JSON.stringify({ 'gadgets#2': 'Alpha' }));
  const page = generate(opts(d, { dryRun: true }), deps([raw(2, 'gadgets')])).page;
  assert.match(page, /\| `cc33` \| .* \| proj-9 \|/);
  assert.match(page, /### Alpha\n\n\| Ticket/);
  writeFileSync(join(d, 'stream-overrides.json'), '{nope');
  assert.throws(() => generate(opts(d), deps([])), /stream-overrides\.json is not valid JSON/);
  assert.equal(existsSync(join(d, 'NOW.md')), false);
});

test('a failed ledger or GitHub read throws and leaves the previous page untouched', () => {
  const d = dir();
  generate(opts(d), deps([]));
  const before = readFileSync(join(d, 'NOW.md'), 'utf8');
  assert.throws(() => generate(opts(d), deps([], { fetchPrs: () => { throw new Error('gh down'); } })), /gh down/);
  assert.throws(() => generate(opts(d), deps([], { journal: () => { throw new Error('ledger down'); } })), /ledger down/);
  assert.equal(readFileSync(join(d, 'NOW.md'), 'utf8'), before);
});

test('UNKNOWN mergeable states are read once more after a pause', () => {
  const slept: number[] = [];
  let calls = 0;
  const fetchPrs = (): RawPr[] => { calls++; return [raw(1, 'acme-widgets', { mergeable: calls === 1 ? 'UNKNOWN' : 'CONFLICTING' })]; };
  const page = generate(opts(dir(), { dryRun: true }), deps([], { fetchPrs, sleep: (ms) => slept.push(ms) })).page;
  assert.deepEqual(slept, [5000]);
  assert.match(page, /\*\*CONFLICTING\*\*/);
});

test('nothing in the page names an install: no org, vault or tracker unless the config gives one', () => {
  const bare: PageConfig = { streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: 'T/{id}', trackerKeyPattern: CONFIG.trackerKeyPattern, tz: 'UTC' };
  const page = generate(opts(dir(), { dryRun: true, config: bare }), deps([raw(5, 'whatever')])).page;
  assert.doesNotMatch(page, /obsidian:\/\/|tracker\.test|atlassian/);
  assert.match(page, /### other/);
  assert.match(page, /\| FAKE-5 \|/, 'a key with no tracker URL is plain text');
});

test('regenerating keeps an answer, a tick and a priorities edit the watcher has not reported, and records the generator\'s own hash', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'First' }, { text: 'Second' }]);
  generate(opts(d), deps([]));
  const typed = readFileSync(join(d, 'NOW.md'), 'utf8').replace('`bb22`\n  > answer: ', '`bb22`\n  > answer: go ahead').replace('- [ ] `cc33`', '- [x] `cc33`').replace('2. Second', '2. Mine');
  writeFileSync(join(d, 'NOW.md'), typed);
  const again = generate(opts(d), deps([])).page;
  assert.match(again, /`bb22`\n {2}> answer: go ahead\n/);
  assert.match(again, /- \[x\] `cc33`/);
  assert.match(again, /2\. Mine/);
  const meta = JSON.parse(readFileSync(join(d, '.now-seen.json'), 'utf8'));
  assert.equal(meta.carried, 3);
  assert.deepEqual(meta.priorities_seen, ['First', 'Second'], 'the carried priorities edit does not become the "last rendered" list');
});

test('--dry-run shows the carried edit but writes neither the page nor the watcher files', () => {
  const d = dir();
  generate(opts(d), deps([]));
  writeFileSync(join(d, 'NOW.md'), readFileSync(join(d, 'NOW.md'), 'utf8').replace('`bb22`\n  > answer: ', '`bb22`\n  > answer: typed'));
  const before = readFileSync(join(d, '.now-seen.json'), 'utf8');
  assert.match(generate(opts(d, { dryRun: true }), deps([])).page, /answer: typed/);
  assert.equal(readFileSync(join(d, '.now-seen.json'), 'utf8'), before);
});
