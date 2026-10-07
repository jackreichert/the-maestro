// Run: node --test scripts/web/client/test/gate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateView } from '../src/gate.ts';

const prs = [
  { repo: 'example/acme-widgets', short: 'acme-widgets', number: 12, url: 'https://github.com/example/acme-widgets/pull/12' },
];

test('a PR gate matching an open PR links to the URL the server sent, labelled repo#n', () => {
  assert.deepEqual(gateView('gh:pr:acme-widgets#12', prs), { lead: 'Waiting on', label: 'acme-widgets#12', mono: true, url: 'https://github.com/example/acme-widgets/pull/12' });
  assert.equal(gateView('gh:pr:example/Acme-Widgets#12', prs).url, prs[0].url, 'the repo matches without case');
});

test('an owner/repo PR gate with no open PR links to its GitHub pull request; a bare repo stays plain', () => {
  assert.deepEqual(gateView('gh:pr:example/ops-tools#7', prs), { lead: 'Waiting on', label: 'ops-tools#7', mono: true, url: 'https://github.com/example/ops-tools/pull/7' });
  assert.deepEqual(gateView('gh:pr:ops-tools#7', prs), { lead: 'Waiting on', label: 'ops-tools#7', mono: true });
  assert.deepEqual(gateView('gh:pr:acme-widgets#13', prs), { lead: 'Waiting on', label: 'acme-widgets#13', mono: true }, 'a different number is not the open PR');
});

test('date and ticket gates read as words', () => {
  assert.deepEqual(gateView('date:2026-10-12', prs), { lead: 'Waiting until', label: 'Monday 12 October', mono: false });
  assert.deepEqual(gateView('ticket:maestro-12', prs), { lead: 'Waiting on', label: 'maestro-12', mono: true });
});

test('anything off the gate grammar is free text, and a token that only looks like a URL never becomes one', () => {
  assert.deepEqual(gateView('FAKE-3 decision', prs), { lead: 'Waiting on', label: 'FAKE-3 decision', mono: false });
  for (const bad of ['gh:pr:evil.test/x/y#1', 'gh:pr:a/b#1x', 'gh:pr:javascript:alert(1)#1', 'gh:pr:a b#1']) {
    assert.equal(gateView(bad, prs).url, undefined, bad);
  }
});

test('dot-only owner or repo segments are free text, never a link', () => {
  for (const bad of ['gh:pr:../x#1', 'gh:pr:./x#1', 'gh:pr:a/..#1', 'gh:pr:...#2']) {
    assert.deepEqual(gateView(bad, prs), { lead: 'Waiting on', label: bad, mono: false }, bad);
  }
});
