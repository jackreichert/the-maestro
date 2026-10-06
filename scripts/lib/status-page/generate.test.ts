// Run: node --test scripts/lib/status-page/generate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherInputs, generate, loadPrs } from './generate.ts';
import { extractFields } from './inline.ts';
import type { GenerateDeps, RawPr } from './generate.ts';
import { writePriorities } from './priorities.ts';
import { readPodium } from './seen.ts';
import { prFlagNames, renderPage } from './render.ts';
import type { PageConfig, Pr } from './render.ts';

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
    queued: [], blocked: [], done: [{ id: 'dd44', date: '2026-10-05', text: 'shipped' }],
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
  const ev = { items: [], ticketMap: {}, overrides: { 'unmapped#4': 'Alpha', 'gadgets#2': 'Gamma' }, repoStreams: CONFIG.repoStreams, keyPattern: CONFIG.trackerKeyPattern };
  const prs = loadPrs([raw(1, 'acme-widgets'), raw(2, 'gadgets'), raw(3, 'unmapped'), raw(4, 'unmapped')], ev);
  assert.deepEqual(prs.map((p) => p.stream), ['Alpha', 'Gamma', 'other', 'Alpha']);
  assert.equal(prs[0]?.unresolved, 1);
});

test('writes The-Podium.md with the freshness line, then the priorities, then the asks grouped by stream, each with links and an answer stub under it', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'Get widgets out', stream: 'Alpha' }, { text: 'Unmapped goal' }]);
  const r = generate(opts(d), deps([raw(12, 'acme-widgets')]));
  assert.deepEqual(r.written, [join(d, 'The-Podium.md')]);
  const page = readFileSync(join(d, 'The-Podium.md'), 'utf8');
  assert.equal(page, r.page);
  const lines = page.split('\n');
  assert.match(lines[lines.indexOf('# The Podium') + 2] ?? '', /^Updated 11:00 am ET · PR data 11:00 am ET \(2026-10-05\)\./);
  assert.equal(lines[lines.indexOf('# The Podium') + 4], "## Today's priorities");
  assert.match(page, /1\. Get widgets out _\[Alpha: awaiting 1 · in flight 1 · open PRs 1\]_\n2\. Unmapped goal\n/);
  assert.match(page, /### Alpha \(1\)\n\n- \[ \] `bb22` \*\*Merge widgets #12 now\?\*\* See FAKE-12 \(<span style=\"white-space:nowrap\">\[proj-7\]\(obsidian:[^)]*\)<\/span> · <span style=\"white-space:nowrap\">\[FAKE-12\]\(https:\/\/tracker\.test\/browse\/FAKE-12\)<\/span> · <span style=\"white-space:nowrap\">\[#12\]\(https:\/\/example\.test\/acme-widgets\/pull\/12\)<\/span>\)\n  > answer: \n/, 'under its stream: id, the full decision, context, clickable tickets and PR, then the answer stub');
  assert.match(page, /### Gamma \(1\)\n\n- \[ \] `cc33` \*\*old question \| with a pipe\*\* _10 days old_\n  > answer: \n/, 'a stream only the ledger knows still gets its heading, old asks say so');
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
  assert.equal(existsSync(join(d, 'The-Podium.md')), false);
  const snap = generate(opts(d, { snapshot: true }), deps([]));
  assert.deepEqual(snap.written, [join(d, 'The-Podium.md'), join(d, '2026-10-05.md')]);
  assert.equal(readFileSync(join(d, '2026-10-05.md'), 'utf8'), snap.page);
});

test('ticket-map.json and stream-overrides.json beside the page are read; invalid JSON stops before any write', () => {
  const d = dir();
  writeFileSync(join(d, 'ticket-map.json'), JSON.stringify({ 'proj-9': ['cc33'] }));
  writeFileSync(join(d, 'stream-overrides.json'), JSON.stringify({ 'gadgets#2': 'Alpha' }));
  const page = generate(opts(d, { dryRun: true }), deps([raw(2, 'gadgets')])).page;
  assert.match(page, /- \[ \] `cc33` [^\n]*\[proj-9\]\(obsidian:[^)]*\)/);
  assert.match(page, /### Alpha \(1\)\n\n\| Ticket/, 'the PR table under the override');
  writeFileSync(join(d, 'stream-overrides.json'), '{nope');
  assert.throws(() => generate(opts(d), deps([])), /stream-overrides\.json is not valid JSON/);
  assert.equal(existsSync(join(d, 'The-Podium.md')), false);
});

test('a failed ledger read throws and leaves the previous page untouched', () => {
  const d = dir();
  generate(opts(d), deps([]));
  const before = readFileSync(join(d, 'The-Podium.md'), 'utf8');
  assert.throws(() => generate(opts(d), deps([], { journal: () => { throw new Error('ledger down'); } })), /ledger down/);
  assert.equal(readFileSync(join(d, 'The-Podium.md'), 'utf8'), before);
});

const ghDown = (): RawPr[] => { throw new Error('gh read failed after 3 tries: HTTP 502\nsecond line'); };

test('a good GitHub read is cached with its fetch time in .now-prs.json', () => {
  const d = dir();
  generate(opts(d), deps([raw(12, 'acme-widgets')]));
  const cache = JSON.parse(readFileSync(join(d, '.now-prs.json'), 'utf8'));
  assert.equal(cache.fetched_at, NOW.toISOString());
  assert.equal(cache.prs[0].number, 12);
  generate(opts(dir(), { dryRun: true }), deps([raw(1, 'acme-widgets')]));
  assert.equal(existsSync(join(d, '.now-prs.json')), true);
});

test('a failed GitHub read still writes the page from the cached PRs, under a warning that names the cache time', () => {
  const d = dir();
  generate(opts(d), deps([raw(12, 'acme-widgets')], { now: () => new Date('2026-10-05T14:31:00Z') }));
  const r = generate(opts(d), deps([], { fetchPrs: ghDown }));
  assert.match(r.page, /\*\*Warning: GitHub could not be read \(gh read failed after 3 tries: HTTP 502\)\. The PR tables below are from the last good read at 10:31 am ET and may be out of date\.\*\*/);
  assert.doesNotMatch(r.page, /second line/);
  assert.match(r.page, /\[#12 → develop\]/, 'the cached PR is still in the tables');
  assert.equal(readFileSync(join(d, 'The-Podium.md'), 'utf8'), r.page, 'the page was written');
  assert.equal(JSON.parse(readFileSync(join(d, '.now-prs.json'), 'utf8')).fetched_at, '2026-10-05T14:31:00.000Z', 'a failed read leaves the cache as it was');
});

test('cachedPrsOnly renders the cached PRs under their own fetch time, with no GitHub read and no warning', () => {
  const d = dir();
  generate(opts(d), deps([raw(12, 'acme-widgets')], { now: () => new Date('2026-10-05T14:31:00Z') }));
  const r = generate(opts(d, { cachedPrsOnly: true }), deps([], { fetchPrs: () => { throw new Error('gh must not be called'); } }));
  assert.match(r.page, /\[#12 → develop\]/);
  assert.doesNotMatch(r.page, /Warning: GitHub/);
  assert.equal(r.prFailure, undefined);
  assert.equal(JSON.parse(readFileSync(join(d, '.now-prs.json'), 'utf8')).fetched_at, '2026-10-05T14:31:00.000Z', 'the cache keeps its fetch time');
});

test('with no cache, a failed GitHub read says the PR tables are empty because they could not be read', () => {
  const d = dir();
  const page = generate(opts(d), deps([], { fetchPrs: ghDown })).page;
  assert.match(page, /No earlier PR data is cached, so the PR tables below are empty because they could not be read, not because nothing is open\./);
  assert.equal(existsSync(join(d, 'The-Podium.md')), true);
  assert.equal(existsSync(join(d, '.now-prs.json')), false);
});

test('a cache from an earlier day names its date; a damaged cache counts as no cache', () => {
  const d = dir();
  generate(opts(d), deps([raw(12, 'acme-widgets')], { now: () => new Date('2026-10-04T14:31:00Z') }));
  assert.match(generate(opts(d, { dryRun: true }), deps([], { fetchPrs: ghDown })).page, /last good read at 2026-10-04 10:31 am ET/);
  writeFileSync(join(d, '.now-prs.json'), JSON.stringify({ fetched_at: '2026-10-05T14:31:00Z', prs: [{ number: 3 }] }));
  assert.match(generate(opts(d, { dryRun: true }), deps([], { fetchPrs: ghDown })).page, /No earlier PR data is cached/);
  writeFileSync(join(d, '.now-prs.json'), '{nope');
  assert.match(generate(opts(d, { dryRun: true }), deps([], { fetchPrs: ghDown })).page, /No earlier PR data is cached/);
});

test('the inline answer and tick survive a GitHub failure', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'First' }]);
  generate(opts(d), deps([raw(12, 'acme-widgets')]));
  const page = readFileSync(join(d, 'The-Podium.md'), 'utf8').replace('> answer: ', '> answer: ship it').replace('- [ ] `bb22`', '- [x] `bb22`');
  writeFileSync(join(d, 'The-Podium.md'), page);
  const after = generate(opts(d), deps([], { fetchPrs: ghDown })).page;
  assert.match(after, /> answer: ship it/);
  assert.match(after, /- \[x\] `bb22`/);
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
  assert.match(page, /### other \(1\)/);
  assert.match(page, /\| <span style=\"white-space:nowrap\">FAKE-5<\/span> \|/, 'a key with no tracker URL is plain text');
});

test('regenerating keeps an answer, a tick and a priorities edit the watcher has not reported, and records the generator\'s own hash', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'First' }, { text: 'Second' }]);
  generate(opts(d), deps([]));
  const typed = readFileSync(join(d, 'The-Podium.md'), 'utf8').replace(/(`bb22`[^\n]*)\n  > answer: /, '$1\n  > answer: go ahead').replace('- [ ] `cc33`', '- [x] `cc33`').replace('2. Second', '2. Mine');
  writeFileSync(join(d, 'The-Podium.md'), typed);
  const again = generate(opts(d), deps([])).page;
  assert.match(again, /`bb22`[^\n]*\n {2}> answer: go ahead\n/);
  assert.match(again, /- \[x\] `cc33`/);
  assert.match(again, /2\. Mine/);
  const meta = JSON.parse(readFileSync(join(d, '.now-seen.json'), 'utf8'));
  assert.equal(meta.carried, 3);
  assert.deepEqual(meta.priorities_seen, ['First', 'Second'], 'the carried priorities edit does not become the "last rendered" list');
});

test('--dry-run shows the carried edit but writes neither the page nor the watcher files', () => {
  const d = dir();
  generate(opts(d), deps([]));
  writeFileSync(join(d, 'The-Podium.md'), readFileSync(join(d, 'The-Podium.md'), 'utf8').replace(/(`bb22`[^\n]*)\n  > answer: /, '$1\n  > answer: typed'));
  const before = readFileSync(join(d, '.now-seen.json'), 'utf8');
  assert.match(generate(opts(d, { dryRun: true }), deps([])).page, /answer: typed/);
  assert.equal(readFileSync(join(d, '.now-seen.json'), 'utf8'), before);
});

test('the priorities section states the date of the list it shows', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'First' }]);
  assert.match(generate(opts(d, { dryRun: true }), deps([])).page, /## Today's priorities\n\n1\. First\nSet for 2026-10-05\.\n/);
});

test('open PRs land under their stream by ticket key, one table per stream, empty streams get none', () => {
  const page = generate(opts(dir(), { dryRun: true }), deps([raw(12, 'gadgets'), raw(40, 'unmapped', { title: 'chore: no key here', headRefName: 'chore/x' })])).page;
  assert.match(page, /### Alpha \(1\)\n\n\| Ticket \| Develop PR \(base\) \| Staging twin \(base\) \| TL;DR \|/, 'FAKE-12 is named by an Alpha ask, so a gadgets PR is Alpha');
  assert.match(page, /### other \(1\)/);
  assert.doesNotMatch(page, /### Gamma \(\d+\)\n\n\| Ticket/, 'no PRs, no table');
  assert.doesNotMatch(page, /No open PRs/);
});

test('develop and staging twins share a row, by title and by ticket key; a missing twin reads none', () => {
  const prs = [
    raw(10, 'acme-widgets', { title: 'feat: add thing FAKE-1', headRefName: 'feat/FAKE-1' }),
    raw(11, 'acme-widgets', { title: 'feat: add thing FAKE-1 (staging)', baseRefName: 'staging', headRefName: 'feat/FAKE-1-staging' }),
    raw(20, 'acme-widgets', { title: 'fix: reworded FAKE-2', headRefName: 'fix/a' }),
    raw(21, 'acme-widgets', { title: 'fix: another wording FAKE-2', baseRefName: 'staging', headRefName: 'fix/b' }),
    raw(30, 'acme-widgets', { title: 'fix: lonely FAKE-3', headRefName: 'fix/c' }),
  ];
  const rows = generate(opts(dir(), { dryRun: true }), deps(prs)).page.split('\n').filter((l) => /^\| <span style=\"white-space:nowrap\">\[FAKE-[123]\]/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0] ?? '', /\[#10 → develop\].*\| <span[^>]*>\[#11 → staging\]/);
  assert.match(rows[1] ?? '', /\[#20 → develop\].*\| <span[^>]*>\[#21 → staging\]/);
  assert.match(rows[2] ?? '', /\[#30 → develop\].* \| none \|/);
});

test('sections come in the order priorities, working on now, queued, needs attention, open PRs, other status, status, and the bottom lists carry ages and done times', () => {
  const b = { ...board, status: { ...board.status,
    inflight: [{ id: 'aa11', date: '2026-10-05', ts: '2026-10-05T13:00:00Z', text: 'building a thing', stream: 'Alpha' }],
    queued: [{ id: 'qq66', date: '2026-10-05', ts: '2026-10-05T12:00:00Z', text: 'someday job', stream: 'Alpha' }],
    blocked: [{ id: 'ee55', date: '2026-10-05', ts: '2026-10-05T14:30:00Z', text: 'waiting on a vendor' }],
    done: [{ id: 'dd44', date: '2026-10-05', ts: '2026-10-05T14:00:00Z', text: 'shipped' }],
    footer: { ledger: [{ name: 'Alpha', done: 0, inflight: 1, queued: 1, awaiting: 1, paste: 0, blocked: 0 }], session: { available: false, unavailable: 'no sessions' } } } };
  const page = generate(opts(dir(), { dryRun: true }), deps([raw(12, 'acme-widgets')], { journal: (sub) => b[sub] })).page;
  const heads = page.split('\n').filter((l) => /^#{1,3} /.test(l));
  assert.deepEqual(heads.map((h) => h.replace(/ \(\d+\)$/, '')), ['# The Podium', "## Today's priorities", '## Working on now', '## Queued', '## Needs attention now', '### Alpha', '### Gamma', '## Open PRs', '### Alpha', '## Other status and findings', '### In flight', '### Blocked', '### Recent done', '### Deferred', '## Status']);
  assert.match(page, /\| Alpha \| `aa11` \| building a thing \| - \| - \| 2 h \(since 9:00 am ET\) \|\n/);
  assert.match(page, /\| Alpha \| 0 \| 1 \| 1 \| 1 \| 0 \| 0 \|\n/);
  assert.match(page, /- `aa11` building a thing \[Alpha\] · 2 h\n/);
  assert.match(page, /- `ee55` waiting on a vendor \(gate: none recorded\) · 30 min\n/);
  assert.match(page, /- `dd44` shipped · 10:00 am ET\n/);
});

/** A clock that only moves when the code sleeps, so lock waits take no real time. */
const fakeClock = (startMs: number) => {
  let t = startMs;
  return { now: () => new Date(t), sleep: (ms: number) => { t += ms; }, at: () => t };
};
const lockPath = (d: string): string => join(d, '.now.lock');

test('a rebuild holds .now.lock while it runs and removes it after, even when it fails', () => {
  const d = dir();
  let during = false;
  generate(opts(d), deps([], { journal: (sub) => { during = existsSync(lockPath(d)); return board[sub]; } }));
  assert.equal(during, true);
  assert.equal(existsSync(lockPath(d)), false);
  assert.throws(() => generate(opts(d), deps([], { journal: () => { throw new Error('ledger read failed'); } })), /ledger read failed/);
  assert.equal(existsSync(lockPath(d)), false, 'a failed run still releases the lock');
});

test('a second rebuild waits for a live holder, then runs once the lock is released', () => {
  const d = dir();
  const clock = fakeClock(NOW.getTime());
  writeFileSync(lockPath(d), JSON.stringify({ pid: 4242, at: clock.at() }));
  let sleeps = 0;
  const r = generate(opts(d), deps([], { now: clock.now, pidAlive: () => true, sleep: (ms) => { clock.sleep(ms); if (++sleeps === 3) rmSync(lockPath(d)); } }));
  assert.equal(sleeps, 3);
  assert.equal(existsSync(join(d, 'The-Podium.md')), true);
  assert.equal(r.written.length, 1);
});

test('a rebuild gives up with "already running" when a live holder keeps the lock past the timeout, and writes nothing', () => {
  const d = dir();
  const clock = fakeClock(NOW.getTime());
  writeFileSync(lockPath(d), JSON.stringify({ pid: 4242, at: clock.at() }));
  assert.throws(() => generate(opts(d), deps([], { now: clock.now, sleep: clock.sleep, pidAlive: () => true })), /already running \(pid 4242/);
  assert.equal(existsSync(join(d, 'The-Podium.md')), false);
  assert.equal(readFileSync(lockPath(d), 'utf8').includes('4242'), true, 'the holder\'s lock is left alone');
});

test('a lock whose holder is gone, or that is older than 30 minutes, is taken over', () => {
  for (const [label, holder, alive] of [['dead holder', { pid: 4242, at: NOW.getTime() }, false], ['old lock', { pid: 4242, at: NOW.getTime() - 31 * 60_000 }, true]] as const) {
    const d = dir();
    writeFileSync(lockPath(d), JSON.stringify(holder));
    const clock = fakeClock(NOW.getTime());
    let sleeps = 0;
    generate(opts(d), deps([], { now: clock.now, sleep: (ms) => { sleeps++; clock.sleep(ms); }, pidAlive: () => alive }));
    assert.equal(sleeps, 0, `${label}: no waiting`);
    assert.equal(existsSync(join(d, 'The-Podium.md')), true, label);
    assert.equal(existsSync(lockPath(d)), false, label);
  }
});

test('a live holder keeps its lock for as long as a slow GitHub run can take (29 minutes old is not stale)', () => {
  const d = dir();
  const clock = fakeClock(NOW.getTime());
  writeFileSync(lockPath(d), JSON.stringify({ pid: 4242, at: clock.at() - 29 * 60_000 }));
  assert.throws(() => generate(opts(d), deps([], { now: clock.now, sleep: clock.sleep, pidAlive: () => true })), /already running/);
});

test('a cache whose nested nodes are damaged counts as no cache', () => {
  const d = dir();
  generate(opts(d), deps([raw(12, 'acme-widgets')]));
  const cache = JSON.parse(readFileSync(join(d, '.now-prs.json'), 'utf8'));
  cache.prs[0].commits.nodes = [{}];
  writeFileSync(join(d, '.now-prs.json'), JSON.stringify(cache));
  assert.match(generate(opts(d, { dryRun: true }), deps([], { fetchPrs: ghDown })).page, /No earlier PR data is cached/);
});

test('an unreadable lock file counts as stale; --dry-run neither takes nor waits for the lock', () => {
  const d = dir();
  writeFileSync(lockPath(d), 'not json');
  generate(opts(d), deps([]));
  assert.equal(existsSync(join(d, 'The-Podium.md')), true);
  writeFileSync(lockPath(d), JSON.stringify({ pid: 4242, at: NOW.getTime() }));
  assert.match(generate(opts(d, { dryRun: true }), deps([], { pidAlive: () => true })).page, /# The Podium/);
});

test('the freshness line carries the page time and the PR-data time in ET, and they differ when the PRs come from the cache', () => {
  const d = dir();
  generate(opts(d), deps([raw(12, 'acme-widgets')], { now: () => new Date('2026-10-05T18:31:00Z') }));
  const later = generate(opts(d), deps([], { fetchPrs: ghDown, now: () => new Date('2026-10-05T18:34:00Z') })).page;
  assert.match(later, /^Updated 2:34 pm ET · PR data 2:31 pm ET \(2026-10-05\)\. Regenerated by/m);
  const fresh = generate(opts(d, { dryRun: true }), deps([], { now: () => new Date('2026-10-05T18:40:00Z') })).page;
  assert.match(fresh, /^Updated 2:40 pm ET · PR data 2:40 pm ET /m);
  assert.match(generate(opts(dir(), { dryRun: true }), deps([], { fetchPrs: ghDown })).page, /^Updated 11:00 am ET · PR data unavailable \(2026-10-05\)\./m);
});

test('the first run leaves NOW.md as a pointer note to The-Podium, and later runs keep it a pointer', () => {
  const d = dir();
  generate(opts(d), deps([]));
  const pointer = readFileSync(join(d, 'NOW.md'), 'utf8');
  assert.match(pointer, /\[\[The-Podium\]\]/);
  assert.doesNotMatch(pointer, /## Today's priorities|> answer:/);
  generate(opts(d), deps([]));
  assert.equal(readFileSync(join(d, 'NOW.md'), 'utf8'), pointer);
  assert.match(readFileSync(join(d, 'The-Podium.md'), 'utf8'), /^# The Podium$/m);
});

test('a legacy NOW.md page with an unreported answer and tick migrates into The-Podium.md, then becomes the pointer', () => {
  const d = dir();
  generate(opts(d), deps([]));
  const legacy = readFileSync(join(d, 'The-Podium.md'), 'utf8').replace('> answer: ', '> answer: from the old page').replace('- [ ] `bb22`', '- [x] `bb22`');
  rmSync(join(d, 'The-Podium.md'));
  writeFileSync(join(d, 'NOW.md'), legacy);
  const r = generate(opts(d), deps([]));
  assert.deepEqual(r.written, [join(d, 'The-Podium.md')]);
  assert.match(r.page, /> answer: from the old page/);
  assert.match(r.page, /- \[x\] `bb22`/);
  assert.match(readFileSync(join(d, 'The-Podium.md'), 'utf8'), /> answer: from the old page/);
  assert.match(readFileSync(join(d, 'NOW.md'), 'utf8'), /\[\[The-Podium\]\]/);
});

test('a pointer note is never read as a page, and a NOW.md edited beside an existing Podium is left alone', () => {
  const d = dir();
  generate(opts(d), deps([]));
  assert.equal(readPodium(d), readFileSync(join(d, 'The-Podium.md'), 'utf8'));
  writeFileSync(join(d, 'NOW.md'), 'my own notes\n');
  generate(opts(d), deps([]));
  assert.equal(readFileSync(join(d, 'NOW.md'), 'utf8'), 'my own notes\n');
});

test('a dry run migrates nothing and writes no pointer', () => {
  const d = dir();
  writeFileSync(join(d, 'NOW.md'), '# old\n');
  generate(opts(d, { dryRun: true }), deps([]));
  assert.equal(readFileSync(join(d, 'NOW.md'), 'utf8'), '# old\n');
  assert.equal(existsSync(join(d, 'The-Podium.md')), false);
});

test('a clean full-page NOW.md rebuilt beside the Podium (by an old loop) becomes the pointer again; one with unreported edits is left alone', () => {
  const d = dir();
  generate(opts(d), deps([]));
  const page = readFileSync(join(d, 'The-Podium.md'), 'utf8');
  writeFileSync(join(d, 'NOW.md'), page);
  generate(opts(d), deps([]));
  assert.match(readFileSync(join(d, 'NOW.md'), 'utf8'), /\[\[The-Podium\]\]/);
  const typed = page.replace('> answer: ', '> answer: typed in the old place');
  writeFileSync(join(d, 'NOW.md'), typed);
  generate(opts(d), deps([]));
  assert.equal(readFileSync(join(d, 'NOW.md'), 'utf8'), typed);
});

test('a long ask is shown whole, never clipped, and its answer survives regeneration', () => {
  const d = dir();
  const long = `Decide ${'which of the many open items to take first and why '.repeat(6)}for FAKE-1111, FAKE-2222, FAKE-3333, FAKE-4444, FAKE-5555, FAKE-6666?`;
  const withLong = { ...board, status: { ...board.status, awaiting: [{ id: 'ee55', date: '2026-10-05', text: `${long} Context after the question.`, stream: 'Alpha' }] } };
  const mk = (): GenerateDeps => deps([], { journal: (sub) => withLong[sub] });
  const page = generate(opts(d), mk()).page;
  assert.ok(page.includes(`**${long}**`), 'the whole decision is on the page');
  assert.doesNotMatch(page.split('## Open PRs')[0] as string, /\.\.\./, 'nothing in the asks is clipped');
  assert.match(page, /\[FAKE-6666\]\(https:\/\/tracker\.test\/browse\/FAKE-6666\)/, 'every tracker key links, not just two');
  writeFileSync(join(d, 'The-Podium.md'), page.replace(/(`ee55`[^\n]*)\n  > answer: /, '$1\n  > answer: take the first'));
  const again = generate(opts(d), mk()).page;
  assert.match(again, /`ee55`[^\n]*\n {2}> answer: take the first\n/, 'the typed answer is carried onto the long ask');
  assert.deepEqual(extractFields(again).answers, { ee55: 'take the first' });
});

test('text clipped elsewhere on the page ends at a word boundary, never mid-word', () => {
  const d = dir();
  const text = `${'alphabetical '.repeat(12)}tail`;
  const withLong = { ...board, status: { ...board.status, inflight: [{ id: 'ff66', date: '2026-10-05', text, stream: 'Alpha' }] } };
  const page = generate(opts(d, { dryRun: true }), deps([], { journal: (sub) => withLong[sub] })).page;
  const row = page.split('\n').find((l) => l.includes('`ff66`')) as string;
  assert.match(row, /alphabetical\.\.\. \|/, 'cut after a whole word');
});

test('gatherInputs plus renderPage is exactly the page generate writes, so a second view of the board reads the same inputs', () => {
  const d = dir();
  writePriorities(d, '2026-10-05', [{ text: 'Get widgets out', stream: 'Alpha' }]);
  const prs = [raw(12, 'acme-widgets'), raw(13, 'acme-widgets', { baseRefName: 'staging' })];
  const o = opts(d, { dryRun: true });
  const inputs = gatherInputs(o, deps(prs));
  assert.equal(renderPage({ ...inputs, command: o.command }).page, generate(o, deps(prs)).page);
  assert.equal(inputs.prs.length, 2);
  assert.equal(inputs.priorities.state, 'ok');
});

test('prFlagNames lists what needs a look on a PR, in the order the Markdown flags show it', () => {
  const pr = { mergeable: 'CONFLICTING', ci: 'ERROR', unresolved: 2, reviewDecision: 'CHANGES_REQUESTED' } as Pr;
  assert.deepEqual(prFlagNames(pr), ['CONFLICTING', 'CI FAIL', '2 thr', 'changes requested']);
  assert.deepEqual(prFlagNames({ mergeable: 'MERGEABLE', ci: 'SUCCESS', unresolved: 0, reviewDecision: null } as Pr), []);
});
