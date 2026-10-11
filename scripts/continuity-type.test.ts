// Run: node --test scripts/continuity-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import * as cont from './event-types/continuity.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import { isAllScopeHandoff, liveTranscripts } from './lib/continuous-roll.ts';
import { withContinuityLock } from './lib/continuity.ts';
import { addWatch } from './lib/watch-registry.ts';
import type { ContinuityIo, ContinuityState } from './event-types/continuity.ts';
import type { LedgerRow } from './lib/ledger-core.ts';

const T0 = Date.parse('2026-10-11T13:00:00Z');
const row = (entrypoint: string, text = 'always keep the ledger current'): string => JSON.stringify({ type: 'user', entrypoint, timestamp: '2026-10-11T12:00:00.000Z', message: { content: text } });

/** A fake world: one live transcript, a ledger that grows when asks are raised, and a handoff that is as new as the last write. */
function rig(transcriptText = `${row('cli')}\n`, lockDir = mkdtempSync(join(tmpdir(), 'cont-lock-'))) {
  const calls: string[][] = [];
  const ledger: LedgerRow[] = [{ ts: '2026-10-11T12:30:00.000Z', kind: 'note', text: 'work' } as LedgerRow];
  let handoffAt: string | null = null;
  let snapshots = 0;
  let snapshotFail = false;
  const io: ContinuityIo = {
    transcripts: () => [{ path: '/t.jsonl', text: transcriptText }],
    handoffPath: (d) => `/j/HANDOFF-${d}-live.md`,
    lockDir,
    deps: {
      journal: (a) => {
        calls.push(a);
        if (a[0] === 'ask') ledger.push({ ts: new Date(T0).toISOString(), kind: 'ask', text: a[1], used: 'loop:continuity' } as LedgerRow);
        if (a[0] === 'handoff') handoffAt = new Date(T0 + 1000).toISOString();
        return { ok: true, out: '' };
      },
      readLedger: () => ledger,
      newestHandoff: () => (handoffAt ? { name: 'HANDOFF-x-live.md', at: handoffAt } : null),
      snapshot: () => { snapshots++; if (snapshotFail) throw new Error('disk full'); return { worktrees: 1, copied: 0, current: 1, skipped: 0, partial: false, capped: false }; },
    },
  };
  let state: ContinuityState | null = null;
  return {
    calls, lockDir, snapshots: () => snapshots, failSnapshot: (v: boolean) => { snapshotFail = v; },
    at: (now: number) => { const prev = state; state = cont.check('/projects', { now, prev }, io); return { state, events: cont.diff(prev, state) }; },
  };
}

test('the first tick raises the decision and writes the live handoff; the second finds everything current and writes nothing', () => {
  const r = rig();
  const first = r.at(T0);
  assert.deepEqual(first.events, []);
  assert.equal(first.state.error, '');
  assert.equal(r.calls.filter((c) => c[0] === 'ask').length, 1);
  assert.deepEqual(r.calls.find((c) => c[0] === 'handoff'), ['handoff', '--all', '--no-worktree-sweep', '--force', '--window', 'live', '--out', '/j/HANDOFF-2026-10-11-live.md']);
  assert.ok(r.calls.every((c) => c[0] !== 'ask' || c.includes('loop:continuity')), 'its rows carry the loop mark');
  const before = r.calls.length;
  r.at(T0 + 300_000);
  assert.equal(r.calls.length, before, 'the second tick wrote nothing');
});

test('a held lock skips the tick without a write or an alert', () => {
  const r = rig();
  const held = withContinuityLock(r.lockDir, 0, () => r.at(T0));
  assert.ok(held.ran);
  assert.deepEqual(held.value.events, []);
  assert.deepEqual(r.calls, [], 'nothing was written while the lock was held');
  assert.equal(r.snapshots(), 0);
});

test('a failing step is one actionable event, not repeated while the message stays the same, and recovery clears it', () => {
  const r = rig();
  r.failSnapshot(true);
  const bad = r.at(T0);
  assert.deepEqual(bad.events, [{ summary: 'continuity tick failed: snapshot: disk full', actionable: true }]);
  assert.deepEqual(r.at(T0 + 300_000).events, []);
  r.failSnapshot(false);
  const good = r.at(T0 + 600_000);
  assert.deepEqual([good.state.error, good.events], ['', []]);
  assert.ok(good.state.lastOk);
});

test('liveTranscripts takes recent interactive top-level transcripts only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-tx-'));
  const write = (rel: string, text: string, ageMs = 0): void => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
    const t = new Date(T0 - ageMs);
    utimesSync(p, t, t);
  };
  write('live.jsonl', `${row('cli')}\n`);
  write('headless.jsonl', `${row('sdk-cli')}\n`);
  write('old.jsonl', `${row('cli')}\n`, 7 * 3_600_000);
  write('session/subagents/agent-1.jsonl', `${row('cli')}\n`);
  write('notes.txt', 'x');
  assert.deepEqual(liveTranscripts(dir, T0).map((t) => t.path), [join(dir, 'live.jsonl')]);
  assert.deepEqual(liveTranscripts(join(dir, 'missing'), T0), []);
});

test('the live handoff counts as a whole-ledger handoff', () => {
  assert.deepEqual(['HANDOFF-2026-10-11-live.md', 'HANDOFF-2026-10-11-Options.md'].map(isAllScopeHandoff), [true, false]);
});

test('validate refuses a missing folder; the type is a registered singleton standing watch with a playbook', () => {
  assert.throws(() => cont.validate(join(tmpdir(), 'no-such-continuity-dir')), /transcripts folder/);
  assert.doesNotThrow(() => cont.validate(mkdtempSync(join(tmpdir(), 'cont-ok-'))));
  assert.ok(BUILTIN_TYPES.continuity);
  assert.deepEqual([cont.interval, cont.singleton, cont.renews, cont.backoff, cont.network], [300, true, true, false, false]);
});

test('in the loop: a failure is an actionable event and success is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-loop-'));
  const target = mkdtempSync(join(tmpdir(), 'cont-target-'));
  const r = rig();
  addWatch(dir, { id: 'c', type: 'continuity', target, done_when: '', report: '', notify_overnight: false, notify: false, interval: null, renew: true }, T0);
  const types = { ...BUILTIN_TYPES, continuity: { ...cont, check: (_t: string, c: Parameters<typeof cont.check>[1]) => ({ ...r.at(c.now).state }) } };
  const quiet = tick({ dir, types, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config: { quietHours: 'off' }, now: T0 });
  assert.deepEqual(quiet.events, []);
  r.failSnapshot(true);
  const failed = tick({ dir, types, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config: { quietHours: 'off' }, now: T0 + 600_000 });
  assert.deepEqual(failed.events.map((e) => [e.summary, e.actionable]), [['continuity tick failed: snapshot: disk full', true]]);
});
