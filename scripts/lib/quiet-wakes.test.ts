// Run: node --test scripts/lib/quiet-wakes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quietVerdict } from './quiet-wakes.ts';
import type { PrState, QuietDeps, SweepOutcome } from './quiet-wakes.ts';
import { sweepSuppressed, triageEvents, triagePath } from './digest-triage.ts';
import type { DigestEvent } from './types.ts';

const AT = '2026-10-12T14:00:00.000Z';
const U = 'https://github.com/org/repo/pull/7';
const LEFT = `LEFT-OPEN-SET org/repo#7 (merged or closed) ${U}`;
const ev = (watch: string, type: string, summary: string): DigestEvent => ({ watch, type, at: AT, summary, actionable: true, report: 'do the thing' });
const tmp = () => mkdtempSync(join(tmpdir(), 'quiet-'));
const rows = (dir: string) => readFileSync(triagePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** Stand-in deps that record what was asked of them. */
function fakes(over: { sweep?: SweepOutcome | (() => never); state?: PrState | undefined; noteThrows?: boolean; closed?: string[] | 'throws' } = {}) {
  const calls = { sweep: 0, state: [] as string[], notes: [] as string[], closeRows: 0 };
  const deps: QuietDeps = {
    sweep: () => { calls.sweep += 1; if (typeof over.sweep === 'function') return over.sweep(); return over.sweep ?? { status: 'clean' }; },
    prState: (repo, n) => { calls.state.push(`${repo}#${n}`); return 'state' in over ? over.state : 'MERGED'; },
    closeRows: () => { calls.closeRows += 1; if (over.closed === 'throws') throw new Error('sweep exited 2'); return over.closed ?? []; },
    note: (text) => { if (over.noteThrows) throw new Error('ledger locked'); calls.notes.push(text); },
  };
  return { deps, calls };
}

test('continuity events are suppressed, with or without deps', () => {
  const e = ev('continuity', 'continuity', 'continuity tick failed: snapshot budget');
  assert.equal(quietVerdict(e)?.action, 'suppress');
  assert.equal(quietVerdict(e, fakes().deps)?.rule, 'continuity-info');
});

test('a clean merge-sweep is suppressed and ledgered; findings wake with the findings in the summary', () => {
  const wake = ev('merge-sweep-hourly', 'wake', 'wake: run the merge sweep');
  const clean = fakes();
  assert.equal(quietVerdict(wake, clean.deps)?.action, 'suppress');
  assert.equal(clean.calls.notes.length, 1);
  const found = fakes({ sweep: { status: 'findings', summary: '2 merged (ab12, cd34)' } });
  const v = quietVerdict(wake, found.deps);
  assert.deepEqual([v?.action, v?.rule], ['wake', 'merge-sweep-findings']);
  assert.match((v as { summary: string }).summary, /run the merge sweep \| merge-sweep: 2 merged \(ab12, cd34\)/);
  assert.equal(found.calls.notes.length, 0);
});

test('a merge-sweep that cannot run wakes (fail open)', () => {
  const v = quietVerdict(ev('merge-sweep-hourly', 'wake', 'wake: x'), fakes({ sweep: { status: 'failed', reason: 'exit 2' } }).deps);
  assert.deepEqual([v?.action, v?.rule], ['wake', 'merge-sweep-failed']);
});

test('only the merge-sweep-hourly wake runs the sweep; another wake is left alone', () => {
  const f = fakes();
  assert.equal(quietVerdict(ev('standup', 'wake', 'wake: standup'), f.deps), null);
  assert.equal(quietVerdict(ev('merge-sweep-hourly', 'reminder', 'x'), f.deps), null);
  assert.equal(f.calls.sweep, 0);
});

test('left-open-set: MERGED suppresses with a note; closed, open and a gh failure wake', () => {
  const merged = fakes();
  assert.equal(quietVerdict(ev('prs', 'pr-watch', LEFT), merged.deps)?.action, 'suppress');
  assert.deepEqual(merged.calls.state, ['org/repo#7']);
  assert.match(merged.calls.notes[0] ?? '', /org\/repo#7 left the open set/);
  for (const [state, why] of [['CLOSED', /without merging/], ['OPEN', /still open/], [undefined, /gh could not read/]] as const) {
    const f = fakes({ state });
    const v = quietVerdict(ev('prs', 'pr-watch', `[self-review] ${LEFT}`), f.deps);
    assert.deepEqual([v?.action, v?.rule], ['wake', 'left-open-set-unmerged']);
    assert.match(v?.reason ?? '', why);
    assert.equal(f.calls.notes.length, 0);
  }
});

test('without deps the outside-world rules do nothing and gh is never asked', () => {
  assert.equal(quietVerdict(ev('prs', 'pr-watch', LEFT)), null);
  assert.equal(quietVerdict(ev('merge-sweep-hourly', 'wake', 'wake: x')), null);
});

test('a ledger note that cannot be written keeps the event awake', () => {
  const v = quietVerdict(ev('prs', 'pr-watch', LEFT), fakes({ noteThrows: true }).deps);
  assert.deepEqual([v?.action, v?.rule], ['wake', 'left-open-set-merged']);
  assert.match(v?.reason ?? '', /ledger note failed/);
});

test('other pr-watch lines and other types are untouched', () => {
  const f = fakes();
  for (const e of [ev('prs', 'pr-watch', `CONFLICT org/repo#7 main <- x ${U}`), ev('texts', 'inbox', '2 new messages'), ev('r', 'reminder', 'reminder: x')]) assert.equal(quietVerdict(e, f.deps), null);
  assert.deepEqual(f.calls.state, []);
});

test('triageEvents applies the rules: suppressed lines go inactive, are logged as noise and appear in the hourly sweep', () => {
  const dir = tmp();
  const f = fakes({ sweep: { status: 'findings', summary: '1 merged (ab12)' } });
  const events = [ev('continuity', 'continuity', 'continuity tick failed: x'), ev('prs', 'pr-watch', LEFT), ev('merge-sweep-hourly', 'wake', 'wake: sweep'), ev('prs', 'pr-watch', `CONFLICT org/repo#7 main <- x ${U}`)];
  triageEvents(events, { dir, quiet: f.deps });
  assert.deepEqual(events.map((e) => e.actionable), [false, false, true, true]);
  assert.equal(events[1]?.report, '');
  assert.match(events[2]?.summary ?? '', /merge-sweep: 1 merged \(ab12\)/);
  assert.deepEqual(rows(dir).map((r) => [r.decision, r.rule]), [['noise', 'continuity-info'], ['noise', 'left-open-set-merged'], ['wake', 'merge-sweep-findings'], ['wake', 'new-conflict']]);
  const sweep = sweepSuppressed(dir, Date.parse(AT) + 1000);
  assert.match(sweep?.summary ?? '', /^TRIAGE-SWEEP 2 lines suppressed/);
  assert.equal(sweep?.actionable, false);
});

test('triageEvents with no quiet deps still suppresses continuity and leaves left-open-set awake', () => {
  const dir = tmp();
  const events = [ev('continuity', 'continuity', 'x'), ev('prs', 'pr-watch', LEFT)];
  triageEvents(events, { dir });
  assert.deepEqual(events.map((e) => e.actionable), [false, true]);
});

test('the loop health lines of a quiet watch still wake: the rules never see them', () => {
  const dir = tmp();
  const f = fakes();
  const events = [ev('continuity', 'continuity', 'check keeps failing: boom'), ev('merge-sweep-hourly', 'wake', 'watch expired before it finished (wake hourly:20)')];
  triageEvents(events, { dir, quiet: f.deps });
  assert.deepEqual(events.map((e) => e.actionable), [true, true]);
  assert.equal(f.calls.sweep, 0);
});

test('left-open-set MERGED closes the linked rows first and the note names them', () => {
  const f = fakes({ closed: ['ab12'] });
  const v = quietVerdict(ev('pr-watch', 'pr-watch', LEFT), f.deps);
  assert.deepEqual([v?.action, v?.rule], ['suppress', 'left-open-set-merged']);
  assert.equal(f.calls.closeRows, 1);
  assert.match(f.calls.notes[0] ?? '', /closed on merge: ab12/);
});

test('left-open-set: rows are closed only for a merged PR, and a failed close wakes instead of dropping the event', () => {
  const open = fakes({ state: 'OPEN', closed: ['ab12'] });
  assert.equal(quietVerdict(ev('pr-watch', 'pr-watch', LEFT), open.deps)?.action, 'wake');
  assert.equal(open.calls.closeRows, 0, 'a PR that is not merged closes nothing');
  const broken = fakes({ closed: 'throws' });
  const v = quietVerdict(ev('pr-watch', 'pr-watch', LEFT), broken.deps);
  assert.equal(v?.action, 'wake');
  assert.match((v as { reason: string }).reason, /closing its rows failed/);
  assert.equal(broken.calls.notes.length, 0);
});

test('a clean merge-sweep that closed rows says so in its ledger note', () => {
  const f = fakes({ sweep: { status: 'clean', closed: ['ab12', 'cd34'] } });
  assert.equal(quietVerdict(ev('merge-sweep-hourly', 'wake', 'wake: x'), f.deps)?.action, 'suppress');
  assert.match(f.calls.notes[0] ?? '', /closed on merge: ab12, cd34/);
});

test('triageEvents: every must-wake class stays actionable and never reaches gh, the sweep or the ledger', () => {
  const dir = tmp();
  const f = fakes();
  const events = [
    ev('prs', 'pr-watch', `THREAD org/repo#7 by alice (human): needs a guard ${U}`),
    ev('prs', 'pr-watch', `REVIEW org/repo#7 by alice (CHANGES_REQUESTED) ${U}`),
    ev('prs', 'pr-watch', `REVIEW-REQUESTED org/repo#7 by alice ${U}`),
    ev('prs', 'pr-checks', `CHECKS-FAILING org/repo#7 ${U}`),
    ev('status', 'status-watch', 'status-watch: jack answered ask abc123'),
    ev('texts', 'inbox', '2 new messages'),
    ev('continuity', 'continuity', 'check keeps failing: boom'),
    ev('merge-sweep-hourly', 'wake', 'watch expired before it finished (wake hourly:20)'),
  ];
  triageEvents(events, { dir, quiet: f.deps });
  assert.deepEqual(events.map((e) => e.actionable), events.map(() => true));
  assert.deepEqual([f.calls.state, f.calls.sweep, f.calls.notes], [[], 0, []]);
});

test('triageEvents: a left-open-set line wakes when gh says closed or open, or fails, and is suppressed only when merged', () => {
  for (const [state, actionable] of [['MERGED', false], ['CLOSED', true], ['OPEN', true], [undefined, true]] as const) {
    const events = [ev('prs', 'pr-watch', LEFT)];
    triageEvents(events, { dir: tmp(), quiet: fakes({ state }).deps });
    assert.equal(events[0]?.actionable, actionable, String(state));
  }
});

test('triageEvents: a throwing gh or sweep wakes instead of dropping the event', () => {
  const boom = { ...fakes().deps, prState: () => { throw new Error('gh missing'); }, sweep: () => { throw new Error('spawn failed'); } };
  const events = [ev('prs', 'pr-watch', LEFT), ev('merge-sweep-hourly', 'wake', 'wake: sweep')];
  triageEvents(events, { dir: tmp(), quiet: boom });
  assert.deepEqual(events.map((e) => e.actionable), [true, true]);
});
