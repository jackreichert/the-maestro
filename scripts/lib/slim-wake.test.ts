// Run: node --test scripts/lib/slim-wake.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { triageEvents, triagePath } from './digest-triage.ts';
import type { PrState, QuietDeps } from './quiet-wakes.ts';
import { SLIM_WAKE_TABLE } from './slim-wake.ts';
import type { DigestEvent } from './types.ts';
import { tick } from '../event-loop.ts';
import type { EventType } from './types.ts';
import { addWatch, readDigest } from './watch-registry.ts';

const AT = '2026-10-11T12:00:00.000Z';
const U = 'https://github.com/org/repo/pull/7';
const ev = (summary: string, type = 'pr-watch'): DigestEvent => ({ watch: 'w', type, at: AT, summary, actionable: true, report: 'r' });
const quietDeps = (state: PrState | undefined): QuietDeps => ({ sweep: () => ({ status: 'clean' }), prState: () => state, note: () => {} });
const run = (summary: string, slim: boolean, opts: { type?: string; state?: PrState } = {}): DigestEvent => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-wake-'));
  return triageEvents([ev(summary, opts.type)], { dir, slim, quiet: quietDeps(opts.state) })[0] as DigestEvent;
};

const PODIUM: [string, string, PrState?][] = [
  ['READY', `READY org/repo#7 draft -> ready ${U}`],
  ['APPROVED', `DECISION org/repo#7: REVIEW_REQUIRED -> APPROVED ${U}`],
  ['APPROVED-UNMERGED', `APPROVED-UNMERGED org/repo#7 ${U}`],
  ['DECISION', `DECISION org/repo#7: APPROVED -> NONE ${U}`],
  ['bot thread', `THREAD org/repo#7 by copilot-pull-request-reviewer[bot]: ${U}#r1`],
  ['bot reply', `REPLY org/repo#7 by dependabot[bot]: ${U}#r2`],
  ['bot review', `REVIEW org/repo#7 by copilot-pull-request-reviewer[bot] (COMMENTED): ${U}`],
  ['COPILOT-REVIEW', 'COPILOT-REVIEW org/repo#7: reviewed, 2 unresolved bot threads'],
  ['COPILOT-LATE', 'COPILOT-LATE org/repo#7 abc: no Copilot review 15 min after it was triggered'],
  ['REVIEW-WAIT', `REVIEW-WAIT org/repo#7 ${U}`],
  ['LEFT-OPEN-SET closed unmerged', `LEFT-OPEN-SET org/repo#7 (merged or closed) ${U}`, 'CLOSED'],
  ['self-review tagged READY', `[self-review] READY org/repo#7 draft -> ready ${U}`],
];

const WAKE: [string, string, PrState?][] = [
  ['red checks', `CHECKS-FAILING org/repo#7 ${U}`],
  ['CHANGES_REQUESTED review', `REVIEW org/repo#7 by alice (CHANGES_REQUESTED): ${U}`],
  ['CHANGES_REQUESTED decision', `DECISION org/repo#7: NONE -> CHANGES_REQUESTED ${U}`],
  ['human thread', `THREAD org/repo#7 by alice: ${U}#r1`],
  ['human reply', `REPLY org/repo#7 by alice: ${U}#r2`],
  ['human comment', `COMMENT org/repo#7 by alice: ${U}`],
  ['human review', `REVIEW org/repo#7 by alice (COMMENTED): ${U}`],
  ['LEFT-OPEN-SET still open', `LEFT-OPEN-SET org/repo#7 (merged or closed) ${U}`, 'OPEN'],
  ['LEFT-OPEN-SET gh unreadable', `LEFT-OPEN-SET org/repo#7 (merged or closed) ${U}`],
  ['unknown pr-watch kind', `SOMETHING-NEW org/repo#7 ${U}`],
];

test('slim: each podium-only class becomes an info line, logged as noise, with its report dropped', () => {
  for (const [name, summary, state] of PODIUM) {
    const e = run(summary, true, { state });
    assert.equal(e.actionable, false, name);
    assert.equal(e.report, '', name);
  }
});

test('slim: a demotion is logged with a slim- rule so the hourly sweep lists it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slim-wake-log-'));
  triageEvents([ev(`READY org/repo#7 draft -> ready ${U}`)], { dir, slim: true });
  const [row] = readFileSync(triagePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([row.decision, row.rule, row.kind], ['noise', 'slim-ready', 'ready']);
  assert.match(row.reason, /nothing to do/);
});

test('slim: classes that need action still wake, and so does an unknown pr-watch kind', () => {
  for (const [name, summary, state] of WAKE) assert.equal(run(summary, true, { state }).actionable, true, name);
});

test('slim: other watch types are never demoted (status-watch answer, budget line, standup reminder)', () => {
  for (const [type, summary] of [['status-watch', 'answer: ticked'], ['spend-watch', 'budget hard line reached'], ['reminder', 'reminder: standup'], ['something-unknown', 'READY org/repo#7']]) {
    assert.equal(run(summary as string, true, { type }).actionable, true, type);
  }
});

test('full mode: nothing is demoted, whatever the line', () => {
  for (const [name, summary, state] of [...PODIUM, ...WAKE]) assert.equal(run(summary, false, { state }).actionable, true, name);
});

test('the table has no row after which a wake row can be shadowed: every wake row precedes every podium row', () => {
  const first = SLIM_WAKE_TABLE.findIndex((r) => r.action === 'podium');
  assert.ok(SLIM_WAKE_TABLE.slice(first).every((r) => r.action === 'podium'));
});

test('a slim tick demotes READY to an info digest line; the same tick in full mode wakes', () => {
  for (const mode of ['slim', 'full'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'slim-wake-tick-'));
    let n = 0;
    const type: EventType<{ n: number }> = { check: () => ({ n: n++ }), diff: (prev) => (prev ? [{ summary: `READY org/repo#7 draft -> ready ${U}` }] : []) };
    addWatch(dir, { id: 'w', type: 'pr-watch', target: 't', ttlMs: 86400000 }, Date.parse(AT));
    const base = { dir, types: { 'pr-watch': type }, mode, config: { quietHours: 'off', tz: 'UTC' } as const };
    tick({ ...base, now: Date.parse(AT) });
    const out = tick({ ...base, now: Date.parse(AT) + 10 * 60_000 });
    assert.deepEqual(out.events.map((e) => e.actionable), [mode === 'full'], mode);
    assert.equal(readDigest(dir).some((e) => e.actionable), mode === 'full', mode);
    assert.equal(readDigest(dir).length, 1, `${mode}: the line is kept in the digest, not lost`);
  }
});
