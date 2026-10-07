// Run: node --test scripts/web/client/test/ask-state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskState, UpdateGate } from '../src/ask-state.ts';

test('a draft survives a redraw and is forgotten when emptied', () => {
  const s = new AskState();
  s.setDraft('a1', 'half an answ');
  assert.equal(s.draft('a1'), 'half an answ');   // what a rebuilt card reads back
  s.setDraft('a1', '');
  assert.equal(s.draft('a1'), '');
});

test('a resolved card stays resolved across redraws, and its draft is dropped', () => {
  const s = new AskState();
  s.setDraft('a1', 'typed');
  s.resolve('a1', 'typed');
  assert.equal(s.resolvedAnswer('a1'), 'typed');
  assert.equal(s.draft('a1'), '');
  assert.equal(s.resolvedAnswer('a2'), null);
  s.resolve('a2', '');   // approved as asked: resolved with no answer, not "open"
  assert.equal(s.resolvedAnswer('a2'), '');
});

test('prune forgets asks that left the board only', () => {
  const s = new AskState();
  s.setDraft('a1', 'x');
  s.setDraft('a2', 'y');
  s.resolve('a3', 'z');
  s.prune(['a1']);
  assert.equal(s.draft('a1'), 'x');
  assert.equal(s.draft('a2'), '');
  assert.equal(s.resolvedAnswer('a3'), null);
});

test('data offered while idle is shown at once', () => {
  const g = new UpdateGate<string>();
  assert.equal(g.offer('d1'), 'd1');
  assert.equal(g.held, false);
});

test('a pending update does not race a Done click: held through press, released after', () => {
  const g = new UpdateGate<string>();
  g.set({ pointer: true });                   // mousedown on Done
  assert.equal(g.set({ typing: false }), null);   // focusout fires; nothing typed, but the press is still down
  assert.equal(g.offer('d1'), null);
  assert.equal(g.held, true);
  assert.equal(g.set({ pointer: false }), 'd1');  // mouseup and the click have run
  assert.equal(g.held, false);
});

test('while typing the newest offer is the one held, and leaving the field releases it', () => {
  const g = new UpdateGate<string>();
  g.set({ typing: true });
  assert.equal(g.offer('d1'), null);
  assert.equal(g.offer('d2'), null);
  assert.equal(g.set({ typing: false }), 'd2');
  assert.equal(g.set({ typing: false }), null, 'released once');
});

test('a held update waits for every reason to clear', () => {
  const g = new UpdateGate<string>();
  g.set({ typing: true, pointer: true });
  g.offer('d1');
  assert.equal(g.set({ typing: false }), null);
  assert.equal(g.set({ pointer: false }), 'd1');
});

test('Edit answer reopens a copied ask and puts its text back as a draft', () => {
  const s = new AskState();
  s.resolve('a1', 'ship it');
  s.reopen('a1', 'ship it, with a caveat');
  assert.equal(s.resolvedAnswer('a1'), null);   // a redraw now rebuilds the form, not the copied status
  assert.equal(s.draft('a1'), 'ship it, with a caveat');
});
