import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { coldStartDrill } from './cold-start-drill.ts';
import { compareContexts, equivalenceDrill } from './equivalence-drill.ts';
import { SOURCES, buildScratch, fixtureRows, missing, reduceLedger, runHook } from './lib.ts';
import type { Source } from './lib.ts';

test('cold-start drill: a reduced ledger still yields priorities, open ids, asks and how-to pointers', () => {
  const r = coldStartDrill();
  assert.deepEqual(r.missing, [], `facts missing from the startup context: ${r.missing.join(', ')}`);
  assert.equal(r.ok, true);
});

test('equivalence drill: compact, clear and startup carry the same fact set', () => {
  const r = equivalenceDrill();
  assert.deepEqual(r.missing, [], `differences between sources: ${r.missing.join(', ')}`);
  assert.equal(r.ok, true);
});

test('the reduction keeps live rows and their briefs and drops finished work and notes', () => {
  const kept = reduceLedger(fixtureRows('2026-10-11', '2026-10-10')).map((r) => r.id);
  assert.deepEqual(kept, ['wip1', 'brf1', 'wip2', 'blk1', 'wip3', 'ask1']);
});

test('the drills can fail: a fact absent from a context is named, and a source that differs is flagged', () => {
  const s = buildScratch({ reduce: true });
  try {
    const page = runHook(s, 'startup').out;
    assert.deepEqual(missing(s.facts, page), []);
    const cut = page.split('\n').filter((l) => !l.includes('ask1') && !l.includes('lothlorien-keys.md')).join('\n');
    assert.deepEqual(missing(s.facts, cut), ['ask ask1', 'ask ask1-text', 'how-to lothlorien-keys']);
    const contexts = new Map<Source, string>(SOURCES.map((x) => [x, page]));
    assert.deepEqual(compareContexts(s.facts, contexts), []);
    contexts.set('clear', cut);
    assert.ok(compareContexts(s.facts, contexts).includes('clear: id ask1 named by another source only'));
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

// Known gap, not a failure: the cold-start page cites yesterday's priorities file and counts its lines but does not print the text.
test('yesterday priority text is on the startup page', { todo: 'the page points at the priorities file and counts items; it does not print them' }, () => {
  const s = buildScratch({ reduce: true });
  try {
    assert.deepEqual(missing(s.priorityText, runHook(s, 'startup').out), []);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

// Epic done point 3 (crash drill) needs R3, the session marker and recovery. It is a visible TODO, not a skip, so it cannot pass by accident.
test('crash drill: a new cold session names every in-flight item after an unclean end', { todo: 'needs R3 (session marker and recovery); not built yet' }, () => {
  assert.fail('needs R3: there is no session marker to detect an unclean end, so this drill cannot run');
});
