// Run: node --test scripts/lib/home/done.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDone } from './done.ts';
import type { DoneEpic } from './done.ts';

const epic = (over: Partial<DoneEpic> = {}): DoneEpic => ({ id: 'FAKE-1', status: 'open', closed: 2, total: 5, body: '', ref: { label: 'FAKE-1' }, ...over });
const base = { stream: 'acme-widgets', vaultName: undefined };

test('a checklist counts checked of all and is finished only when every box is checked', () => {
  const body = '## What done looks like\n\n- [x] exporter ships\n- [ ] docs updated\n- [x] runbook\n';
  const d = buildDone({ ...base, epics: [epic({ body })], projects: [] });
  assert.deepEqual(d.sources[0]?.items.map((i) => i.checked), [true, false, true]);
  assert.deepEqual(d.sources[0]?.progress, { done: 2, total: 3, unit: 'checked' });
  assert.equal(d.sources[0]?.finished, false);
  const all = buildDone({ ...base, epics: [epic({ body: '## What done looks like\n- [x] a\n- [X] b\n' })], projects: [] });
  assert.equal(all.sources[0]?.finished, true);
});

test('an epic with plain text counts its closed tickets, and finished means all of them closed', () => {
  const body = '## What done looks like\n\nThe exporter is live for every customer.\n';
  const part = buildDone({ ...base, epics: [epic({ body })], projects: [] }).sources[0];
  assert.equal(part?.prose, 'The exporter is live for every customer.');
  assert.deepEqual(part?.progress, { done: 2, total: 5, unit: 'tickets' });
  assert.equal(part?.finished, false);
  assert.equal(buildDone({ ...base, epics: [epic({ body, closed: 5 })], projects: [] }).sources[0]?.finished, true);
});

test('a project CONTEXT section counts as a source and an epic that is closed does not', () => {
  const text = '# Project\n\nWhat it is.\n\n## What done looks like\n\n- one\n- two\n\n## Now\n\n- other\n';
  const d = buildDone({ ...base, epics: [epic({ status: 'closed', body: '## What done looks like\n- x' })], projects: [{ project: 'acme', text }] });
  assert.deepEqual(d.sources.map((s) => [s.kind, s.name]), [['project', 'acme']]);
  assert.deepEqual(d.sources[0]?.items.map((i) => i.text), ['one', 'two']);
  assert.equal(d.sources[0]?.progress, null, 'bullets without boxes and no epic count nothing');
  assert.equal(d.sources[0]?.finished, false);
});

test('with nothing written the stream gets the file to add it to, and no invented goal', () => {
  const d = buildDone({ ...base, epics: [epic()], projects: [{ project: 'acme', text: '# Project\n\n## Now\n' }, { project: 'ops', text: null }] });
  assert.deepEqual(d.sources, []);
  assert.match(d.fix ?? '', /Projects\/acme\/CONTEXT\.md or Projects\/ops\/CONTEXT\.md or the FAKE-1 epic ticket/);
});

test('long lists are capped and say how many are not listed', () => {
  const body = `## What done looks like\n${Array.from({ length: 15 }, (_, i) => `- [ ] item ${i + 1}`).join('\n')}\n`;
  const s = buildDone({ ...base, epics: [epic({ body })], projects: [] }).sources[0];
  assert.equal(s?.items.length, 12);
  assert.equal(s?.more, 3);
  assert.equal(s?.progress?.total, 15);
});
