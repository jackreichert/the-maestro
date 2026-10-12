// Run: node --test scripts/status-watch-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as statusWatch from './event-types/status-watch.ts';
import { generate } from './lib/status-page/generate.ts';
import type { GenerateDeps } from './lib/status-page/generate.ts';
import { writePriorities } from './lib/status-page/priorities.ts';
import type { PageConfig } from './lib/status-page/render.ts';
import { addWatch } from './lib/watch-registry.ts';
import { fold, isOpen } from './lib/ledger-core.ts';
import type { LedgerRow } from './lib/ledger-core.ts';

const NOW = new Date('2026-10-05T15:00:00Z');
const CONFIG: PageConfig = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: 'T/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
let awaiting = [
  { id: 'ab12', date: '2026-10-05', text: 'Merge it now?', stream: 'Alpha' },
  { id: 'cd34', date: '2026-10-05', text: 'Which option?', stream: 'Alpha' },
];
const deps = (): GenerateDeps => ({
  journal: (sub) => (sub === 'status' ? { inflight: [], queued: [], blocked: [], done: [], awaiting } : { items: [] }),
  fetchPrs: () => [], sleep: () => {}, now: () => NOW,
});
const regenerate = (dir: string): string => generate({ statusDir: dir, dryRun: false, snapshot: false, command: 'status-page', config: CONFIG }, deps()).page;
const check = (dir: string) => statusWatch.check(dir);
const events = (dir: string): string[] => statusWatch.diff(null, check(dir)).map((e) => e.summary);
/** Plays the user: types into the file as Obsidian would. */
const userEdits = (dir: string, from: string, to: string): void => {
  const text = readFileSync(join(dir, 'The-Podium.md'), 'utf8');
  assert.ok(text.includes(from), `page has ${from}`);
  writeFileSync(join(dir, 'The-Podium.md'), text.replace(from, to));
};
/** Types into the `> answer:` stub under the ask line of `id` (the ask line carries its text and links, so match to the line end). */
const answer = (dir: string, id: string, text: string): void => {
  const page = readFileSync(join(dir, 'The-Podium.md'), 'utf8');
  const re = new RegExp(`(\\\`${id}\\\`[^\\n]*)\\n  > answer: `);
  assert.match(page, re, `page has the ${id} stub`);
  writeFileSync(join(dir, 'The-Podium.md'), page.replace(re, `$1\n  > answer: ${text}`));
};
const setup = (): string => { awaiting = awaiting.slice(0, 2); const dir = mkdtempSync(join(tmpdir(), 'sw-')); writePriorities(dir, '2026-10-05', [{ text: 'First' }, { text: 'Second' }]); regenerate(dir); return dir; };

test('regenerating the page never fires an event, however often, and with the ledger changing underneath', () => {
  const dir = setup();
  assert.deepEqual(events(dir), []);
  regenerate(dir);
  assert.deepEqual(events(dir), []);
  awaiting.push({ id: 'ef56', date: '2026-10-05', text: 'A new ask', stream: 'Alpha' });
  writePriorities(dir, '2026-10-05', [{ text: 'Changed by the orchestrator' }]);
  regenerate(dir);
  assert.deepEqual(events(dir), [], 'a new ask row and a new priorities list written by the generator are not user edits');
});

test('an answer fires once, with the ask id, the text and what it was about', () => {
  const dir = setup();
  events(dir);
  answer(dir, 'ab12', 'yes, merge it');
  assert.deepEqual(events(dir), ['ask ab12 (decision: Merge it now?) answered: yes, merge it']);
  assert.deepEqual(events(dir), [], 'the same edit is not reported twice');
});

test('a ticked box fires, and answer plus tick on one ask make one event', () => {
  const dir = setup();
  events(dir);
  userEdits(dir, '- [ ] `cd34`', '- [x] `cd34`');
  assert.deepEqual(events(dir), ['ask cd34 (decision: Which option?) ticked']);
  answer(dir, 'ab12', 'ok');
  userEdits(dir, '- [ ] `ab12`', '- [x] `ab12`');
  assert.deepEqual(events(dir), ['ask ab12 (decision: Merge it now?) answered: ok, ticked']);
});

/** Types a `> discuss:` line directly under the ask's answer stub. */
const discuss = (dir: string, id: string, topic: string): void => {
  const page = readFileSync(join(dir, 'The-Podium.md'), 'utf8');
  const re = new RegExp(`(\\\`${id}\\\`[^\\n]*\\n  > answer: [^\\n]*)\\n`);
  assert.match(page, re, `page has the ${id} stub`);
  writeFileSync(join(dir, 'The-Podium.md'), page.replace(re, `$1\n  > discuss: ${topic}\n`));
};

test('a discuss line fires one DISCUSS event with its topic, survives a regeneration until reported, and is not reported twice', () => {
  const dir = setup();
  events(dir);
  discuss(dir, 'ab12', 'rollout order');
  regenerate(dir);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /`ab12`[^\n]*\n {2}> answer: \n {2}> discuss: rollout order\n/);
  assert.deepEqual(events(dir), ['DISCUSS ask ab12 (decision: Merge it now?): rollout order']);
  assert.deepEqual(events(dir), []);
  discuss(dir, 'cd34', '');
  assert.deepEqual(events(dir), ['DISCUSS ask cd34 (decision: Which option?) (no topic given)']);
});

/** A check at `ageSec` seconds after the page was last written, as the loop makes it (with a clock). */
const checkAfter = (dir: string, ageSec: number) => {
  const saved = Date.now() / 1000 - 3600;
  utimesSync(join(dir, 'The-Podium.md'), saved, saved);
  return statusWatch.check(dir, { now: (saved + ageSec) * 1000 });
};

test('an answer saved 5 s before a check is held back, then reported once the page has been quiet for 20 s', () => {
  const dir = setup();
  events(dir);
  answer(dir, 'ab12', 'yes but');
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 5)), [], 'half-typed: not reported');
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 19)), []);
  const settled = statusWatch.diff(null, checkAfter(dir, 21)).map((e) => e.summary);
  assert.deepEqual(settled, ['ask ab12 (decision: Merge it now?) answered: yes but']);
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 60)), [], 'and only once');
});

test('the words finished during the settle window are the ones reported, not the half sentence', () => {
  const dir = setup();
  events(dir);
  answer(dir, 'ab12', 'yes but');
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 5)), []);
  userEdits(dir, 'answer: yes but', 'answer: yes but only after CI');
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 30)).map((e) => e.summary), ['ask ab12 (decision: Merge it now?) answered: yes but only after CI']);
});

test('a page the generator just wrote is quiet at any age, and a fresh page with no edit does not hold the baseline', () => {
  const dir = setup();
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 1)), []);
  regenerate(dir);
  assert.deepEqual(statusWatch.diff(null, checkAfter(dir, 1)), []);
});

test('the type checks every 30 s', () => {
  assert.equal(statusWatch.interval, 30);
});

test('regenerating before the watcher looks keeps the answer, and it still fires exactly once', () => {
  const dir = setup();
  events(dir);
  answer(dir, 'ab12', 'keep me');
  userEdits(dir, '- [ ] `cd34`', '- [x] `cd34`');
  regenerate(dir);
  const page = readFileSync(join(dir, 'The-Podium.md'), 'utf8');
  assert.match(page, /`ab12`[^\n]*\n {2}> answer: keep me\n/);
  assert.match(page, /- \[x\] `cd34`/);
  assert.deepEqual(events(dir), ['ask ab12 (decision: Merge it now?) answered: keep me', 'ask cd34 (decision: Which option?) ticked']);
  assert.deepEqual(events(dir), []);
});

test('with no ledger known, the next regeneration after a report clears the answer and stays quiet; the same words typed again fire again', () => {
  const dir = setup();
  events(dir);
  answer(dir, 'ab12', 'done');
  assert.equal(events(dir).length, 1);
  regenerate(dir);
  assert.doesNotMatch(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /answer: done/);
  assert.deepEqual(events(dir), []);
  answer(dir, 'ab12', 'done');
  assert.equal(events(dir).length, 1);
});

test('an answer for an ask that has left the board survives regeneration under Unprocessed answers and then fires', () => {
  const dir = setup();
  events(dir);
  answer(dir, 'cd34', 'late');
  awaiting = awaiting.filter((a) => a.id !== 'cd34');
  regenerate(dir);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /## Unprocessed answers\n\n- \[ \] `cd34` \(no longer on the board\)\n {2}> answer: late/);
  assert.deepEqual(events(dir), ['ask cd34 answered: late']);
  regenerate(dir);
  assert.doesNotMatch(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /Unprocessed answers/);
});

test('an inline priorities edit fires once and survives regeneration until reported; the next regeneration uses priorities.md again', () => {
  const dir = setup();
  events(dir);
  userEdits(dir, '2. Second', '2. Mine instead');
  regenerate(dir);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /2\. Mine instead/);
  assert.deepEqual(events(dir), ['priorities edited inline: 1) First; 2) Mine instead']);
  regenerate(dir);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /2\. Second/, 'priorities.md is the source again once the edit was reported');
  assert.deepEqual(events(dir), []);
});

test('answers typed before the watcher ever ran are reported on its first check', () => {
  const dir = setup();
  answer(dir, 'ab12', 'early');
  assert.equal(existsSync(join(dir, '.now-seen.md')), false);
  assert.deepEqual(events(dir), ['ask ab12 (decision: Merge it now?) answered: early']);
  assert.equal(existsSync(join(dir, '.now-seen.md')), true);
});

test('a missing The-Podium.md is quiet, not an error', () => {
  assert.deepEqual(events(mkdtempSync(join(tmpdir(), 'sw-empty-'))), []);
});

test('the type is registered, refuses a target that is not a directory, and runs through the loop as an actionable event', () => {
  assert.equal(BUILTIN_TYPES['status-watch'], statusWatch);
  assert.throws(() => statusWatch.validate('/definitely/not/a/dir'), /status directory/);
  const status = setup();
  const t0 = Date.now();
  const reg = mkdtempSync(join(tmpdir(), 'sw-events-'));
  addWatch(reg, { id: 'sw', type: 'status-watch', target: status });
  assert.deepEqual(tick({ dir: reg, types: BUILTIN_TYPES, config: { quietHours: 'off' }, now: t0 }).events, []);
  answer(status, 'ab12', 'via loop');
  const r = tick({ dir: reg, types: BUILTIN_TYPES, config: { quietHours: 'off' }, now: t0 + 120_000 });
  assert.deepEqual(r.events.map((e) => [e.watch, e.type, e.actionable, e.summary]), [['sw', 'status-watch', true, 'ask ab12 (decision: Merge it now?) answered: via loop']]);
  regenerate(status);
  assert.deepEqual(tick({ dir: reg, types: BUILTIN_TYPES, config: { quietHours: 'off' }, now: t0 + 240_000 }).events, []);
});

test('an edit saved while the generator is writing is not overwritten: it reads the page again and carries the edit', () => {
  const dir = setup();
  events(dir);
  let landed = false;
  const racing: GenerateDeps = { ...deps(), beforeWrite: () => { if (!landed) { landed = true; answer(dir, 'ab12', 'saved mid-write'); } } };
  generate({ statusDir: dir, dryRun: false, snapshot: false, command: 'status-page', config: CONFIG }, racing);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /`ab12`[^\n]*\n {2}> answer: saved mid-write\n/);
  assert.deepEqual(events(dir), ['ask ab12 (decision: Merge it now?) answered: saved mid-write']);
});

test('the generator gives up, writing nothing, if the page keeps changing under it', () => {
  const dir = setup();
  const before = readFileSync(join(dir, 'The-Podium.md'), 'utf8');
  let n = 0;
  const racing: GenerateDeps = { ...deps(), beforeWrite: () => writeFileSync(join(dir, 'The-Podium.md'), `${before}\nedit ${++n}\n`) };
  assert.throws(() => generate({ statusDir: dir, dryRun: false, snapshot: false, command: 'status-page', config: CONFIG }, racing), /kept changing/);
  assert.equal(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), `${before}\nedit 3\n`, 'the last thing on disk is the user\'s');
});

test('a decision with emphasis markers is reported whole, the same text the page shows', () => {
  const dir = setup();
  awaiting.push({ id: 'ef56', date: '2026-10-05', text: '*Merge **now**_ok_`x`*? tail', stream: 'Alpha' });
  regenerate(dir);
  events(dir);
  answer(dir, 'ef56', 'yes');
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /`ef56` \*\*\\\*Merge \\\*\\\*now\\\*\\\*\\_ok\\_\\`x\\`\\\*\?\*\* tail/);
  assert.deepEqual(events(dir), ['ask ef56 (decision: *Merge **now**_ok_`x`*?) answered: yes']);
});

test('identifiers with underscores survive on the page and in the event, with no backslash leaking', () => {
  const dir = setup();
  awaiting.push({ id: 'ef57', date: '2026-10-05', text: 'Rename snake_case_name to `camel`?', stream: 'Alpha' });
  regenerate(dir);
  events(dir);
  answer(dir, 'ef57', 'yes');
  assert.deepEqual(events(dir), ['ask ef57 (decision: Rename snake_case_name to `camel`?) answered: yes']);
});

test('an older table page (no ask lines) still gives the decision from the last cell of the row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-old-'));
  const old = (answerText: string): string => ['# The Podium', '', '| id | stream | needed |', '| --- | --- | --- |', '| `ab12` | Alpha | Merge it \\| now? |', `  > answer: ${answerText}`, ''].join('\n');
  writeFileSync(join(dir, 'The-Podium.md'), old(''));
  events(dir);
  writeFileSync(join(dir, 'The-Podium.md'), old('go'));
  assert.deepEqual(events(dir), ['ask ab12 (decision: Merge it | now?) answered: go']);
});

// ── answers recorded in the ledger before the baseline moves ──

/** A ledger in memory: two open asks, and a board read from it the way `status --json` reads the real one. */
const ledger = () => {
  const rows: LedgerRow[] = [
    { id: 'ab12', kind: 'question', ts: '2026-10-05T14:00:00Z', date: '2026-10-05', text: 'Merge it now?', stream: 'Alpha' },
    { id: 'cd34', kind: 'question', ts: '2026-10-05T14:01:00Z', date: '2026-10-05', text: 'Which option?', stream: 'Alpha' },
  ];
  const store = { readLedger: () => rows, append: <E>(e: E): E => { rows.push(e as LedgerRow); return e; }, newId: () => `r${rows.length}` };
  const board = () => fold(rows, null).items.filter((i) => isOpen(i) && i.kind === 'question');
  const gen = (dir: string): string => generate({ statusDir: dir, dryRun: false, snapshot: false, command: 'status-page', config: CONFIG }, {
    journal: (sub) => (sub === 'status' ? { inflight: [], queued: [], blocked: [], done: [], awaiting: board() } : { items: [] }), fetchPrs: () => [], sleep: () => {}, now: () => NOW,
  }).page;
  const io: statusWatch.RecorderFor = () => (edits, nowMs) => statusWatch.recordEdits(store, edits, nowMs);
  const answers = (): [string, string, string][] => rows.filter((r) => r.kind === 'answer' || r.kind === 'discuss').map((r) => [String(r.kind), String(r.of), String(r.text)]);
  return { rows, gen, io, answers };
};
const settledCheck = (dir: string, io: statusWatch.RecorderFor) => statusWatch.diff(null, statusWatch.check(dir, { now: Date.now() + 3600_000 }, io)).map((e) => e.summary);

test('an answer survives a regeneration after it has been reported, because it is in the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-led-'));
  const l = ledger();
  writePriorities(dir, '2026-10-05', [{ text: 'First' }]);
  l.gen(dir);
  assert.deepEqual(settledCheck(dir, l.io), []);
  answer(dir, 'ab12', 'ship it after CI');
  assert.deepEqual(settledCheck(dir, l.io), ['ask ab12 (decision: Merge it now?) answered: ship it after CI']);
  assert.deepEqual(l.answers(), [['answer', 'ab12', 'ship it after CI']]);
  l.gen(dir);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /`ab12`[^\n]*\n {2}> answer: ship it after CI\n/, 'the answer is still on the page after the report and a regeneration');
  assert.deepEqual(settledCheck(dir, l.io), [], 'and the regenerated page is not read as a new edit');
  l.gen(dir);
  assert.deepEqual(settledCheck(dir, l.io), []);
  assert.equal(l.answers().length, 1, 'one row, however often the page is regenerated');
});

test('a tick alone is recorded as (ticked), a discuss mark with its topic, and an ask that has closed takes nothing but still fires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-led-'));
  const l = ledger();
  writePriorities(dir, '2026-10-05', [{ text: 'First' }]);
  l.gen(dir);
  settledCheck(dir, l.io);
  userEdits(dir, '- [ ] `cd34`', '- [x] `cd34`');
  discuss(dir, 'ab12', 'rollout order');
  l.rows.push({ id: 'zz01', kind: 'resolved', closes: 'cd34', ts: '2026-10-05T14:30:00Z', date: '2026-10-05', text: 'done elsewhere' });
  assert.equal(settledCheck(dir, l.io).length, 2);
  assert.deepEqual(l.answers(), [['discuss', 'ab12', 'rollout order']]);
  l.gen(dir);
  assert.match(readFileSync(join(dir, 'The-Podium.md'), 'utf8'), /`ab12`[^\n]*\n {2}> answer: \n {2}> discuss: rollout order\n/);
  userEdits(dir, '- [ ] `ab12`', '- [x] `ab12`');
  settledCheck(dir, l.io);
  assert.deepEqual(l.answers().at(-1), ['answer', 'ab12', '(ticked)']);
});

test('if the ledger write fails the baseline does not move, so the edit is found again and recorded on the next check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-led-'));
  const l = ledger();
  writePriorities(dir, '2026-10-05', [{ text: 'First' }]);
  l.gen(dir);
  settledCheck(dir, l.io);
  answer(dir, 'ab12', 'keep me');
  const broken: statusWatch.RecorderFor = () => () => { throw new Error('ledger is read-only'); };
  assert.throws(() => settledCheck(dir, broken), /read-only/);
  assert.deepEqual(settledCheck(dir, l.io), ['ask ab12 (decision: Merge it now?) answered: keep me']);
  assert.deepEqual(l.answers(), [['answer', 'ab12', 'keep me']]);
});

test('with no ledger configured for this directory there is no recorder, so nothing is written and nothing breaks', () => {
  assert.equal(statusWatch.recorderFor(mkdtempSync(join(tmpdir(), 'sw-none-'))), null);
});
