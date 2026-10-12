// Run: node --test scripts/lib/digest-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLine, rulesOnlyTriage, suppressedSince, sweepSuppressed, triageEvents, triagePath } from './digest-triage.ts';
import type { Triage } from './digest-triage.ts';
import type { DigestEvent } from './types.ts';
import { tick } from '../event-loop.ts';
import type { EventType } from './types.ts';
import { addWatch, readDigest } from './watch-registry.ts';
import { steeringEvent } from '../event-types/pr-watch.ts';
import type { Board, BoardPr } from '../event-types/pr-watch.ts';

const AT = '2026-10-11T12:00:00.000Z';
const U = 'https://github.com/org/repo/pull/7';
const line = (summary: string, type = 'pr-watch') => classifyLine({ watch: 'w', type, at: AT, summary });
const rows = (dir: string) => readFileSync(triagePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the always-actionable lines each hit their own rule', () => {
  assert.equal(line(`REVIEW org/repo#7 by alice (CHANGES_REQUESTED): ${U}`).rule, 'changes-requested');
  assert.equal(line(`DECISION org/repo#7: NONE -> CHANGES_REQUESTED ${U}`).rule, 'changes-requested');
  assert.equal(line(`CONFLICT org/repo#7 main <- feat/x ${U}`).rule, 'new-conflict');
  assert.equal(line(`THREAD org/repo#7 by alice: ${U}#r1`).rule, 'human-thread');
  assert.equal(line(`CHECKS-FAILING org/repo#7 ${U}`).rule, 'failed-check');
  assert.equal(line('CI failing: build, lint', 'pr-checks').rule, 'failed-check');
  for (const l of [`REVIEW org/repo#7 by alice (CHANGES_REQUESTED): ${U}`, `THREAD org/repo#7 by alice: ${U}`]) assert.equal(line(l).verdict, 'wake');
});

test('the self-review tag does not hide a rule', () => {
  assert.equal(line(`[self-review] CONFLICT org/repo#7 main <- feat/x ${U}`).rule, 'new-conflict');
});

test('lines no rule covers are ambiguous, with the reason said', () => {
  for (const s of [`THREAD org/repo#7 by dependabot[bot]: ${U}`, `REPLY org/repo#7 by alice: ${U}`, `COMMENT org/repo#7 by alice: ${U}`, `REVIEW org/repo#7 by alice (APPROVED): ${U}`,
    `CONFLICT-CLEARED org/repo#7 ${U}`, `COPILOT-LATE org/repo#7 abc: late`]) {
    const r = line(s);
    assert.deepEqual([r.verdict, r.rule], ['ambiguous', 'no-rule'], s);
    assert.match(r.reason, /no rule/);
  }
});

test('triageEvents logs every triaged decision, leaves all lines actionable, and skips other types and info lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-'));
  const ev = (type: string, summary: string, actionable = true): DigestEvent => ({ watch: 'w', type, at: AT, summary, actionable, report: '' });
  const events = [ev('pr-watch', `CONFLICT org/repo#7 main <- x ${U}`), ev('pr-watch', `COMMENT org/repo#7 by alice: ${U}`), ev('reminder', 'reminder: stand up'), ev('pr-watch', 'x', false)];
  const out = triageEvents(events, { dir });
  assert.deepEqual(out.map((e) => e.actionable), [true, true, true, false]);
  const r = rows(dir);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => [x.decision, x.rule, x.kind]), [['wake', 'new-conflict', 'conflict'], ['wake', 'no-rule', 'comment']]);
  assert.ok(r.every((x) => x.reason && x.at === AT && x.summary));
});

test('a tick triages its events and an empty tick writes no log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-tick-'));
  let n = 0;
  const type: EventType<{ n: number }> = { check: () => ({ n: n++ }), diff: (prev) => (prev ? [{ summary: `CONFLICT org/repo#7 main <- x ${U}` }] : []) };
  addWatch(dir, { id: 'w', type: 'pr-watch', target: 't', ttlMs: 86400000 }, Date.parse(AT));
  const base = { dir, types: { 'pr-watch': type }, config: { quietHours: 'off', tz: 'UTC' } as const };
  tick({ ...base, now: Date.parse(AT) });
  assert.equal(existsSync(triagePath(dir)), false);
  tick({ ...base, now: Date.parse(AT) + 3600000 });
  assert.deepEqual(rows(dir).map((x) => x.rule), ['new-conflict']);
  assert.equal(readDigest(dir).filter((e) => e.actionable).length, 1);
});

const ev = (summary: string, type = 'pr-watch', actionable = true): DigestEvent => ({ watch: 'w', type, at: AT, summary, actionable, report: 'r' });
const tmp = () => mkdtempSync(join(tmpdir(), 'triage-seam-'));
const COMMENT = `COMMENT org/repo#7 by alice: ${U}`;

test('the rules-only default is unsure, so an ambiguous line wakes', () => {
  assert.equal(rulesOnlyTriage({ watch: 'w', type: 'pr-watch', kind: 'comment', summary: COMMENT }).verdict, 'unsure');
  const dir = tmp();
  const [e] = triageEvents([ev(COMMENT)], { dir });
  assert.equal(e.actionable, true);
  assert.match(rows(dir)[0].reason, /rules-only/);
});

test('noise with a reason suppresses and is logged with that reason; the report is dropped', () => {
  const dir = tmp();
  const noise: Triage = () => ({ verdict: 'noise', reason: 'bare thanks' });
  const [e] = triageEvents([ev(COMMENT)], { dir, triage: noise });
  assert.deepEqual([e.actionable, e.report], [false, '']);
  assert.deepEqual(rows(dir).map((x) => [x.decision, x.rule, x.reason]), [['noise', 'triage', 'bare thanks']]);
  assert.equal(suppressedSince(dir).length, 1);
});

test('the seam is never asked about a rule-covered line, and cannot suppress one', () => {
  const dir = tmp();
  let asked = 0;
  const [e] = triageEvents([ev(`CONFLICT org/repo#7 main <- x ${U}`)], { dir, triage: () => { asked += 1; return { verdict: 'noise', reason: 'x' }; } });
  assert.deepEqual([asked, e.actionable], [0, true]);
});

test('unsure, actionable, a throw, a bad answer and noise without a reason all wake', () => {
  const answers: Triage[] = [() => ({ verdict: 'unsure', reason: 'hm' }), () => ({ verdict: 'actionable', reason: 'asks a question' }),
    () => { throw new Error('model down'); }, () => ({ verdict: 'maybe' }) as never, () => ({ verdict: 'noise', reason: '  ' })];
  for (const triage of answers) {
    const dir = tmp();
    const [e] = triageEvents([ev(COMMENT)], { dir, triage });
    assert.equal(e.actionable, true);
    assert.equal(rows(dir)[0].decision, 'wake');
  }
});

test('the sweep lists suppressed lines once an hour, and only once', () => {
  const dir = tmp();
  const t0 = Date.parse(AT);
  triageEvents([ev(COMMENT), ev(`REPLY org/repo#7 by bob: ${U}`)], { dir, triage: () => ({ verdict: 'noise', reason: 'bot chatter' }) });
  const first = sweepSuppressed(dir, t0 + 1000);
  assert.ok(first && !first.actionable);
  assert.match(first.summary, /^TRIAGE-SWEEP 2 lines suppressed as noise .*bot chatter/);
  assert.equal(sweepSuppressed(dir, t0 + 60 * 1000), null);
  triageEvents([{ ...ev(COMMENT), at: new Date(t0 + 1800 * 1000).toISOString() }], { dir, triage: () => ({ verdict: 'noise', reason: 'again' }) });
  const next = sweepSuppressed(dir, t0 + 3700 * 1000);
  assert.match(next?.summary ?? '', /^TRIAGE-SWEEP 1 line suppressed/);
  assert.equal(sweepSuppressed(dir, t0 + 7400 * 1000), null);
});

test('the sweep does nothing with no log, and a due sweep with no noise is silent', () => {
  const dir = tmp();
  assert.equal(sweepSuppressed(dir, Date.parse(AT)), null);
  assert.equal(existsSync(triagePath(dir)), false);
  triageEvents([ev(`CONFLICT org/repo#7 main <- x ${U}`)], { dir });
  assert.equal(sweepSuppressed(dir, Date.parse(AT) + 1000), null);
});

test('a tick with a noise triage writes an info event, not an actionable one', () => {
  const dir = tmp();
  let n = 0;
  const type: EventType<{ n: number }> = { check: () => ({ n: n++ }), diff: (prev) => (prev ? [{ summary: COMMENT }] : []) };
  addWatch(dir, { id: 'w', type: 'pr-watch', target: 't', ttlMs: 86400000 }, Date.parse(AT));
  const base = { dir, types: { 'pr-watch': type }, config: { quietHours: 'off', tz: 'UTC' } as const, triage: (() => ({ verdict: 'noise', reason: 'thanks' })) as Triage };
  tick({ ...base, now: Date.parse(AT) });
  tick({ ...base, now: Date.parse(AT) + 3600000 });
  const out = readDigest(dir);
  assert.deepEqual(out.map((e) => e.actionable), [false]);
  assert.equal(suppressedSince(dir).length, 1);
});

/** The line pr-watch really emits for a failing check, built by its own emitter (with and without the self-review tag). */
const steerLine = (selfReview: boolean): string => {
  const pr: BoardPr = { url: U, repo: 'org/repo', number: 7, isDraft: false, head: 'sha', headRef: 'feat/x', base: 'develop', mergeable: 'MERGEABLE', needsCopilot: false,
    decision: 'REVIEW_REQUIRED', threads: [], replies: [], comments: [], reviews: [], failingChecks: ['FAILURE'], selfReview };
  const out = steeringEvent({}, { 'org/repo#7': pr } as Board);
  assert.equal(out.length, 1);
  return out[0].summary;
};
const noise: Triage = () => ({ verdict: 'noise', reason: 'looks like noise' });

test('the failing-check line pr-watch emits wakes by rule, tagged or not', () => {
  assert.match(steerLine(false), /^STEER pr 7 failing check FAILURE$/);
  assert.equal(line(steerLine(false)).rule, 'failed-check');
  assert.equal(line(steerLine(true)).rule, 'failed-check');
});

test('a noise answer cannot suppress the failing-check line (triageEvents)', () => {
  for (const sr of [false, true]) {
    const dir = tmp();
    let asked = 0;
    const [e] = triageEvents([ev(steerLine(sr))], { dir, triage: () => { asked += 1; return noise({} as never); } });
    assert.deepEqual([asked, e.actionable, rows(dir)[0].rule], [0, true, 'failed-check']);
  }
});

test('a noise answer cannot suppress the failing-check line (tick)', () => {
  const dir = tmp();
  let n = 0;
  const type: EventType<{ n: number }> = { check: () => ({ n: n++ }), diff: (prev) => (prev ? [{ summary: steerLine(false) }] : []) };
  addWatch(dir, { id: 'w', type: 'pr-watch', target: 't', ttlMs: 86400000 }, Date.parse(AT));
  const base = { dir, types: { 'pr-watch': type }, config: { quietHours: 'off', tz: 'UTC' } as const, triage: noise };
  tick({ ...base, now: Date.parse(AT) });
  tick({ ...base, now: Date.parse(AT) + 3600000 });
  assert.deepEqual(readDigest(dir).map((e) => e.actionable), [true]);
  assert.equal(suppressedSince(dir).length, 0);
});
