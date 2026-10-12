// Run: node --test scripts/stall-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as stall from './event-types/stall.ts';
import type { StallIo, StallState, WorktreeRef } from './event-types/stall.ts';
import { defaultRun } from './event-loop.ts';
import type { LedgerRow } from './lib/ledger-core.ts';
import type { WatchEvent } from './lib/types.ts';

const T0 = Date.parse('2026-10-11T22:00:00Z');
const MIN = 60_000;

/** An in-memory ledger, one worktree and a clock: `step(n)` moves n minutes and runs one check the way the loop does. */
function rig(stallMinutes = 90) {
  let now = T0;
  let n = 0;
  const rows: LedgerRow[] = [];
  const events: WatchEvent[] = [];
  let state: StallState | null = null;
  let activityAt = T0;
  let activityWhat = 'edited a.ts';
  let wts: WorktreeRef[] | null = [{ path: '/c/.worktrees/maestro-111', branch: 'feat/MAESTRO-315-stall' }];
  const io: StallIo = { stallMinutes, rows: () => rows, worktrees: () => wts, activity: () => ({ at: activityAt, what: activityWhat }) };
  const append = (row: Record<string, unknown>): LedgerRow => { const r = { id: `r${++n}`, ts: new Date(now).toISOString(), date: '2026-10-11', ...row } as LedgerRow; rows.push(r); return r; };
  const dispatch = (id = 'aaaa', scope = 'maestro-111') => {
    append({ id, kind: 'wip', text: `build ${id}`, repo: 'the-maestro' });
    append({ kind: 'claim', repo: 'the-maestro', scope, branch: 'feat/MAESTRO-315-stall', text: `claim the-maestro@${scope} for desk: brief ${id}` });
    append({ kind: 'brief', briefs: id, repo: 'the-maestro', text: `brief ${id}` });
  };
  const r = {
    rows, events, append, dispatch, at: () => now,
    state: () => state as StallState,
    work: (what = 'edited a.ts') => { activityAt = now; activityWhat = what; },
    gone: () => { wts = null; },
    step: (minutes: number) => { now += minutes * MIN; const next = stall.check('/c', { now, prev: state, run: defaultRun }, io); events.push(...stall.diff(state, next)); state = next; return next; },
    run: (minutes: number, every = 5) => { for (let m = 0; m < minutes; m += every) r.step(every); },
  };
  return r;
}

test('stall is registered, singleton and local', () => {
  assert.equal(BUILTIN_TYPES.stall, stall);
  assert.equal(stall.singleton, true);
  assert.equal(stall.network, false);
});

test('an active item never fires, however long it runs', () => {
  const r = rig();
  r.dispatch();
  for (let i = 0; i < 48; i++) { r.work(); r.run(15, 5); }
  assert.deepEqual(r.events, []);
});

test('a quiet 40 minute test run under the default does not fire', () => {
  const r = rig();
  r.dispatch();
  r.work();
  r.run(40);
  assert.deepEqual(r.events, []);
  r.run(45);
  assert.equal(r.events.length, 0, 'still under 90 minutes');
});

test('a stalled item fires once, with the id and evidence, not on every tick', () => {
  const r = rig();
  r.dispatch('stal');
  r.work('git logs/HEAD');
  r.run(89, 1);
  assert.equal(r.events.length, 0);
  r.run(10, 1);
  assert.equal(r.events.length, 1);
  const [e] = r.events;
  assert.equal(e?.actionable, true);
  assert.match(e?.summary ?? '', /stalled stal \(the-maestro, worktree maestro-111\): no progress for 9\dm; newest sign git logs\/HEAD at 2026-10-11T22:00Z/);
  r.run(600, 5);
  assert.equal(r.events.length, 1, 'ten more hours of the same stall say nothing');
});

test('progress after a stall re-arms it: a second stall fires again', () => {
  const r = rig();
  r.dispatch();
  r.run(100);
  assert.equal(r.events.length, 1);
  r.work();
  r.run(10);
  assert.equal(r.events.length, 1, 'progress clears it');
  r.run(100);
  assert.equal(r.events.length, 2);
});

test('a re-dispatch starts a new clock and can stall again', () => {
  const r = rig();
  r.dispatch();
  r.run(100);
  assert.equal(r.events.length, 1);
  r.append({ kind: 'brief', briefs: 'aaaa', repo: 'the-maestro', text: 'brief aaaa' });
  r.run(60);
  assert.equal(r.events.length, 1, 'inside the new window');
  r.run(60);
  assert.equal(r.events.length, 2);
});

test('the threshold is the one setting: a lower value fires sooner', () => {
  const r = rig(30);
  r.dispatch();
  r.run(25);
  assert.equal(r.events.length, 0);
  r.run(10);
  assert.equal(r.events.length, 1);
});

test('items it cannot see are never reported: no claim, queued, closed, released, no worktree', () => {
  const r = rig();
  r.append({ id: 'noco', kind: 'wip', text: 'no claim', repo: 'the-maestro' });
  r.append({ id: 'queu', kind: 'wip', queued: true, text: 'queued', repo: 'the-maestro' });
  r.append({ kind: 'claim', repo: 'the-maestro', scope: 'maestro-111', text: 'claim x: brief queu' });
  r.dispatch('done');
  r.append({ kind: 'done', closes: 'done', text: 'done' });
  r.dispatch('rele', 'other');
  r.append({ kind: 'released', repo: 'the-maestro', scope: 'other', text: 'released' });
  r.run(300);
  assert.deepEqual(r.events, []);
  const g = rig();
  g.dispatch();
  g.gone();
  g.run(300);
  assert.deepEqual(g.events, [], 'unreadable git is not a stall');
});

test('a worktree that matches by branch only is found, and another item\'s worktree is not taken', () => {
  const r = rig();
  r.dispatch('aaaa', 'something-else');
  r.run(100);
  assert.equal(r.events.length, 1, 'matched by the claim branch');
  const o = rig();
  o.append({ id: 'bbbb', kind: 'wip', text: 'other', repo: 'the-maestro' });
  o.append({ kind: 'claim', repo: 'the-maestro', scope: 'unrelated', branch: 'feat/other', text: 'claim c: brief bbbb' });
  o.run(300);
  assert.deepEqual(o.events, []);
});

test('real git: a dirty file counts as progress, an untouched worktree stalls', () => {
  const home = mkdtempSync(join(tmpdir(), 'stall-git-'));
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const repo = join(home, 'proj');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(home, 'proj-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const old = new Date(T0 - 5 * 3600_000);
  for (const f of [wt, join(wt, 'a.txt'), join(repo, '.git', 'worktrees', 'proj-wt', 'HEAD'), join(repo, '.git', 'worktrees', 'proj-wt', 'index'), join(repo, '.git', 'worktrees', 'proj-wt', 'logs', 'HEAD')]) utimesSync(f, old, old);
  const io = stall.realIo(home, defaultRun);
  assert.deepEqual(io.worktrees('proj')?.map((w) => w.branch), ['feat/x']);
  const idle = io.activity(wt);
  assert.ok(idle && idle.at <= old.getTime() + 1000, 'untouched worktree reports the old time');
  writeFileSync(join(wt, 'new.txt'), 'edit');
  const busy = io.activity(wt);
  assert.ok(busy && busy.at > old.getTime() + MIN && busy.what === 'edited new.txt', `edit is progress, got ${JSON.stringify(busy)}`);
  assert.equal(io.worktrees('missing'), null);
});
