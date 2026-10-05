// Run: node --test scripts/status-watch-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('after the watcher has reported, the next regeneration clears the answer and stays quiet; the same words typed again fire again', () => {
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
  const reg = mkdtempSync(join(tmpdir(), 'sw-events-'));
  addWatch(reg, { id: 'sw', type: 'status-watch', target: status });
  assert.deepEqual(tick({ dir: reg, types: BUILTIN_TYPES, config: { quietHours: 'off' }, now: 1 }).events, []);
  answer(status, 'ab12', 'via loop');
  const r = tick({ dir: reg, types: BUILTIN_TYPES, config: { quietHours: 'off' }, now: 1 + 120_000 });
  assert.deepEqual(r.events.map((e) => [e.watch, e.type, e.actionable, e.summary]), [['sw', 'status-watch', true, 'ask ab12 (decision: Merge it now?) answered: via loop']]);
  regenerate(status);
  assert.deepEqual(tick({ dir: reg, types: BUILTIN_TYPES, config: { quietHours: 'off' }, now: 1 + 240_000 }).events, []);
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
