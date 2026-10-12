// Run: node --test scripts/lib/digest-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLine, triageEvents, triagePath } from './digest-triage.ts';
import type { DigestEvent } from './types.ts';
import { tick } from '../event-loop.ts';
import type { EventType } from './types.ts';
import { addWatch, readDigest } from './watch-registry.ts';

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
