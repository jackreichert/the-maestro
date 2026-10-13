// Run: node --test scripts/lib/journal/agent-retro.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRetroProblems, missingRetros, parseAgentRetro, parseLesson, pendingRetros, retroGate, retroReviewedProblems, reviewRefusals, seenRetro, LESSONS_MAX } from './agent-retro.ts';
import type { LedgerRow } from '../ledger-core.ts';

// Built at run time so no secret-shaped literal sits in the source.
const FAKE_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const LEARNED = new Set(['ab12']);
const raw = (over: Partial<Parameters<typeof parseAgentRetro>[0]> = {}) => ({ item: 'w001', lessons: [], learned: [], nothing: null, ...over });
const at = (h: number): string => new Date(Date.parse('2026-10-13T08:00:00Z') + h * 3600_000).toISOString();

test('lessons parse with their source, are joined to one line, and the text counts them', () => {
  const r = parseAgentRetro(raw({ lessons: ['code: the cache key\n ignores the locale', 'jack:  stage files by path', 'code: tests sit beside the module'], learned: ['ab12'] }), LEARNED);
  assert.deepEqual(r.fields, {
    retros: 'w001',
    lessons: [{ source: 'code', text: 'the cache key ignores the locale' }, { source: 'jack', text: 'stage files by path' }, { source: 'code', text: 'tests sit beside the module' }],
    learnedIds: ['ab12'],
    text: 'retro: 3 lessons (code 2, jack 1)',
  });
});

test('--nothing with a reason is a retro on its own; with lessons it is refused', () => {
  assert.deepEqual(parseAgentRetro(raw({ nothing: 'a one-line config change' }), LEARNED).fields, { retros: 'w001', lessons: [], nothing: 'a one-line config change', text: 'retro: nothing to learn' });
  assert.match(parseAgentRetro(raw({ nothing: 'x', lessons: ['code: y'] }), LEARNED).errors?.join() ?? '', /takes no --lesson/);
});

test('each malformed input is refused and nothing parses', () => {
  const cases: [Partial<Parameters<typeof parseAgentRetro>[0]>, RegExp][] = [
    [{}, /at least one --lesson/],
    [{ item: null, lessons: ['code: x'] }, /name the item/],
    [{ lessons: ['opinion: x'] }, /must start with a source/],
    [{ lessons: ['code:   '] }, /lesson 1 is empty/],
    [{ lessons: [`code: ${'x'.repeat(301)}`] }, /over 300 characters/],
    [{ lessons: Array.from({ length: LESSONS_MAX + 1 }, (_, i) => `code: fact ${i}`) }, /over 10/],
    [{ lessons: ['code: x'], learned: ['zz99'] }, /not a learned row/],
    [{ nothing: '  ' }, /--nothing is empty/],
  ];
  for (const [over, re] of cases) {
    const r = parseAgentRetro(raw(over), LEARNED);
    assert.equal(r.fields, undefined, String(re));
    assert.match(r.errors?.join(' ') ?? '', re);
  }
});

test('a secret-shaped lesson is refused without echoing the value', () => {
  const r = parseAgentRetro(raw({ lessons: [`code: the key ${FAKE_KEY} works`] }), LEARNED);
  assert.equal(r.fields, undefined);
  assert.match(r.errors?.join() ?? '', /refused by the scanner/);
  assert.doesNotMatch(r.errors?.join() ?? '', new RegExp(FAKE_KEY));
});

test('parseLesson splits on the first colon only', () => {
  assert.deepEqual(parseLesson('process: ask: before pushing'), { source: 'process', text: 'ask: before pushing' });
  assert.equal(parseLesson('no source here'), null);
});

test('the same retro for the same item is found again; a different one is new', () => {
  const f = parseAgentRetro(raw({ lessons: ['code: x'] }), LEARNED).fields;
  assert.ok(f);
  const rows: LedgerRow[] = [{ id: 'r001', kind: 'agent-retro', ...f }];
  assert.deepEqual(seenRetro(rows, f), { kind: 'same', id: 'r001' });
  assert.deepEqual(seenRetro(rows, { ...f, lessons: [{ source: 'code', text: 'y' }] }), { kind: 'new' });
});

test('the done gate refuses only a briefed wip item with no retro', () => {
  const rows: LedgerRow[] = [{ id: 'w001', kind: 'wip', text: 'build it' }, { id: 'b001', kind: 'brief', briefs: 'w001' }, { id: 'w002', kind: 'wip', text: 'by hand' }];
  assert.match(retroGate(rows, { id: 'w001', kind: 'wip' }) ?? '', /agent-retro w001/);
  assert.equal(retroGate(rows, { id: 'w002', kind: 'wip' }), null, 'never briefed');
  assert.equal(retroGate(rows, { id: 'q001', kind: 'question' }), null, 'not work');
  assert.equal(retroGate([...rows, { id: 'r001', kind: 'agent-retro', retros: 'w001' }], { id: 'w001', kind: 'wip' }), null);
});

test('pending retros drop out once reviewed', () => {
  const rows: LedgerRow[] = [{ id: 'r001', kind: 'agent-retro', retros: 'w001' }, { id: 'r002', kind: 'agent-retro', retros: 'w002' }, { id: 'v001', kind: 'retro-reviewed', reviews: 'r001', text: 'promoted' }];
  assert.deepEqual(pendingRetros(rows).map((r) => r.id), ['r002']);
});

test('missing retros start at the first retro, skip unbriefed and reviewed items, and carry the --no-retro reason', () => {
  const rows: LedgerRow[] = [
    { id: 'w000', kind: 'wip', text: 'old work', ts: at(0) }, { id: 'b000', kind: 'brief', briefs: 'w000', ts: at(0) }, { id: 'd000', kind: 'done', closes: 'w000', ts: at(1) },
    { id: 'r000', kind: 'agent-retro', retros: 'w009', ts: at(2) },
    { id: 'w001', kind: 'wip', text: 'briefed', ts: at(3) }, { id: 'b001', kind: 'brief', briefs: 'w001', ts: at(3) }, { id: 'd001', kind: 'done', closes: 'w001', ts: at(4), noRetro: 'agent died' },
    { id: 'w002', kind: 'wip', text: 'by hand', ts: at(3) }, { id: 'd002', kind: 'done', closes: 'w002', ts: at(4) },
    { id: 'w003', kind: 'wip', text: 'seen', ts: at(3) }, { id: 'b003', kind: 'brief', briefs: 'w003', ts: at(3) }, { id: 'd003', kind: 'done', closes: 'w003', ts: at(4) }, { id: 'v003', kind: 'retro-reviewed', reviews: 'w003', text: 'n/a' },
  ];
  assert.deepEqual(missingRetros(rows), [{ item: 'w001', text: 'briefed', closedAt: at(4), closedBy: 'd001', noRetro: 'agent died' }]);
  assert.deepEqual(missingRetros(rows.filter((r) => r.kind !== 'agent-retro' && !r.noRetro)), [], 'no retro on the ledger yet: nothing is missing');
});

test('retro-reviewed takes only an open retro or a missing item, needs a note, and checks promotions', () => {
  const rows: LedgerRow[] = [{ id: 'r001', kind: 'agent-retro', retros: 'w001', ts: at(0) }];
  assert.deepEqual(reviewRefusals(rows, 'r001', ['learned:ab12', 'ticket:proj-042'], 'promoted one fact'), []);
  assert.match(reviewRefusals(rows, 'zz99', [], 'x').join(), /not an unreviewed retro/);
  assert.match(reviewRefusals(rows, 'r001', [], null).join(), /--note is required/);
  assert.match(reviewRefusals(rows, 'r001', ['wiki:page'], 'x').join(), /kind:id/);
});

test('verify re-runs the write rules on stored rows and flags unknown fields', () => {
  const good: LedgerRow = { id: 'r001', kind: 'agent-retro', retros: 'w001', lessons: [{ source: 'code', text: 'x' }], text: 'retro: 1 lesson (code 1)' };
  assert.deepEqual(agentRetroProblems(good, LEARNED), []);
  assert.match(agentRetroProblems({ ...good, lessons: [{ source: 'code', text: `k ${FAKE_KEY}` }] }, LEARNED).join(), /scanner/);
  assert.match(agentRetroProblems({ ...good, extra: 'x' }, LEARNED).join(), /never sets/);
  assert.match(agentRetroProblems({ ...good, retros: undefined }, LEARNED).join(), /names no item/);
  assert.deepEqual(retroReviewedProblems({ id: 'v001', kind: 'retro-reviewed', reviews: 'r001', text: 'ok', promoted: ['learned:ab12'] }), []);
  assert.match(retroReviewedProblems({ id: 'v001', kind: 'retro-reviewed', reviews: 'r001', text: 'ok', promoted: ['bad'] }).join(), /kind:id/);
});
