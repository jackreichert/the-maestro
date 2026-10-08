// Run: node --test scripts/web/client/test/home.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHome } from '../src/contract.ts';
import { awaitingLabel, barSegments, capRows, clearLine, epicEnd, leftGroups, leftHeading, noEpicLine, openCounts, progressSentence, quietNote, ticketNotes, verifiedSentence } from '../src/home-text.ts';
import { home } from './home-fixture.ts';

test('the progress sentence always states its denominator, for every epic shape', () => {
  const shapes: [number, number, string][] = [[0, 0, '0 of 0 closed'], [1, 4, '1 of 4 closed (25%)'], [3, 3, '3 of 3 closed (100%)'], [9, 14, '9 of 14 closed (64%)'], [0, 5, '0 of 5 closed (0%)']];
  for (const [closed, total, want] of shapes) assert.equal(progressSentence({ closed, total }), want);
  assert.match(progressSentence({ closed: 200, total: 312 }), /^200 of 312 closed/);
});

test('verification is its own sentence, and only for an epic that needs it', () => {
  assert.equal(verifiedSentence({ total: 14, verify: { required: true, verified: 6 } }), '6 of 14 verified');
  assert.equal(verifiedSentence({ total: 14, verify: { required: false, verified: 0 } }), null);
});

test('an epic ends only when every ticket is closed, and is unresolved until verified when it needs to be', () => {
  const v = { required: false, verified: 0 };
  assert.equal(epicEnd({ total: 0, closed: 0, verify: v }), null);
  assert.equal(epicEnd({ total: 3, closed: 2, verify: v }), null);
  assert.equal(epicEnd({ total: 3, closed: 3, verify: v }), 'complete');
  assert.equal(epicEnd({ total: 3, closed: 3, verify: { required: true, verified: 2 } }), 'unresolved');
  assert.equal(epicEnd({ total: 3, closed: 3, verify: { required: true, verified: 3 } }), 'complete');
});

test('open counts and bar segments leave out zeros and keep the reading order', () => {
  assert.equal(openCounts({ inProgress: 2, blocked: 1, notStarted: 2 }), '2 in progress · 1 blocked · 2 not started');
  assert.equal(openCounts({ inProgress: 0, blocked: 0, notStarted: 0 }), '');
  assert.deepEqual(barSegments({ closed: 9, inProgress: 2, blocked: 0, notStarted: 3 }), [{ key: 'closed', n: 9 }, { key: 'progress', n: 2 }, { key: 'todo', n: 3 }]);
});

test('quiet is a fact about a note, shown from two weeks on', () => {
  assert.equal(quietNote(13), null);
  assert.equal(quietNote(null), null);
  assert.equal(quietNote(21), 'quiet 21 days');
  assert.deepEqual(ticketNotes({ points: 1, awaitsYou: true, quietDays: 20 }), ['1 pt', 'awaits you', 'quiet 20 days']);
  assert.deepEqual(ticketNotes({ awaitsYou: false, quietDays: 2 }), []);
});

test('the Clear line folds every empty section into one sentence, and is absent when nothing is empty', () => {
  assert.equal(clearLine([{ phrase: 'nothing blocked', empty: true }, { phrase: 'nothing queued', empty: false }, { phrase: 'nothing deferred', empty: true }]), 'Clear: nothing blocked, nothing deferred.');
  assert.equal(clearLine([{ phrase: 'nothing blocked', empty: false }]), null);
  assert.equal(clearLine([]), null);
});

test('what is left adds loose tickets to Not started once, and the heading says of how many', () => {
  const h = sanitizeHome(home())!.home;
  const g = leftGroups(h);
  assert.deepEqual(g.notStarted.map((t) => t.id), ['avonlea-api-060', 'avonlea-misc-001']);
  assert.equal(g.shown, 3);
  assert.equal(leftHeading(g, h.epics), "What's left (3 of 17)");
  const dup = { ...h, loose: [h.left.notStarted[0]!] };
  assert.equal(leftGroups(dup).notStarted.length, 1);
  assert.equal(leftHeading({ ...g, truncated: 4 }, []), "What's left (7)");
});

test('capRows shows the first five and hands back the rest', () => {
  const { shown, rest } = capRows([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([shown.length, rest.length], [5, 2]);
  assert.deepEqual(capRows([1, 2]).rest, []);
});

test('the no-epic line teaches how to get progress, or says why the vault was not read', () => {
  assert.match(noEpicLine({ epics: [], unknowns: [] }), /No epic is mapped/);
  assert.equal(noEpicLine({ epics: [], unknowns: [{ kind: 'no-vault', text: 'vault_root is not set.' }] }), 'vault_root is not set.');
  assert.equal(awaitingLabel(1), '1 awaits you');
  assert.equal(awaitingLabel(2), '2 await you');
  assert.equal(awaitingLabel(0), null);
});

