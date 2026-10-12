// Run: node --test scripts/stall-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
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
  const reportTimes: Record<string, number> = {};
  let scratchAt = 0;
  let liveNow: boolean | null = false;
  const io: StallIo = { stallMinutes, rows: () => rows, worktrees: () => wts, activity: () => ({ at: activityAt, what: activityWhat }), reportAt: (p) => reportTimes[p] ?? 0, dispatchFiles: () => (scratchAt ? { at: scratchAt, what: 'wrote report-aaaa.md' } : null), live: () => liveNow, liveProcess: () => (liveNow ? 'pid 4242 (sleep)' : null) };
  const append = (row: Record<string, unknown>): LedgerRow => { const r = { id: `r${++n}`, ts: new Date(now).toISOString(), date: '2026-10-11', ...row } as LedgerRow; rows.push(r); return r; };
  const dispatch = (id = 'aaaa', scope = 'maestro-111') => {
    append({ id, kind: 'wip', text: `build ${id}`, repo: 'the-maestro' });
    append({ kind: 'claim', repo: 'the-maestro', scope, branch: 'feat/MAESTRO-315-stall', text: `claim the-maestro@${scope} for desk: brief ${id}` });
    append({ kind: 'brief', briefs: id, repo: 'the-maestro', brief: `/s/brief-${id}.md`, report: `/s/report-${id}.md`, text: `brief ${id}` });
  };
  const r = {
    rows, events, append, dispatch, at: () => now,
    state: () => state as StallState,
    work: (what = 'edited a.ts') => { activityAt = now; activityWhat = what; },
    gone: () => { wts = null; },
    scratch: () => { scratchAt = now; },
    live: (v: boolean | null) => { liveNow = v; },
    writeReport: (id = 'aaaa') => { reportTimes[`/s/report-${id}.md`] = now; },
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

test('an agent that wrote its report and went quiet is reported as finished, not stalled', () => {
  const r = rig();
  r.dispatch('fini');
  r.work();
  r.run(10);
  r.writeReport('fini');
  r.run(95);
  assert.equal(r.events.length, 1);
  const summary = r.events[0]?.summary ?? '';
  assert.match(summary, /^finished fini \(the-maestro, worktree maestro-111\): report \/s\/report-fini\.md was written/);
  assert.match(summary, /Read the report first; do not re-brief/);
  assert.doesNotMatch(summary, /stalled|stall-reset/);
  r.run(300);
  assert.equal(r.events.length, 1, 'still once');
});

test('a report older than the latest dispatch is not a finish: a re-briefed agent that goes quiet is stalled', () => {
  const r = rig();
  r.dispatch('redo');
  r.writeReport('redo');
  r.step(20);
  r.append({ kind: 'brief', briefs: 'redo', repo: 'the-maestro', brief: '/s/brief-redo.md', report: '/s/report-redo.md', text: 'brief redo' });
  r.run(100);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0]?.summary ?? '', /^stalled redo /);
});

test('two 60 minute suites back to back, each writing only to the dispatch scratch files, are not a stall', () => {
  const r = rig();
  r.dispatch();
  r.work();
  r.run(60);
  r.scratch();
  r.run(60);
  r.scratch();
  r.run(60);
  assert.deepEqual(r.events, [], '180 minutes with no worktree write but scratch writes every hour');
  r.run(100);
  assert.equal(r.events.length, 1, 'scratch writes stop: it stalls 90 minutes after the last');
});

test('a live process in the worktree is progress for at most one more stall_minutes; lsof missing changes nothing', () => {
  const r = rig();
  r.dispatch();
  r.work();
  r.live(true);
  r.run(120);
  assert.deepEqual(r.events, [], 'two 60 minute suites: a process runs there');
  r.live(false);
  r.run(55);
  assert.deepEqual(r.events, [], 'the cap is the newest file sign plus one stall_minutes, so 180 minutes in');
  r.run(10);
  assert.equal(r.events.length, 1, 'the process is gone, past the cap');
  const n = rig();
  n.dispatch();
  n.live(null);
  n.run(100);
  assert.equal(n.events.length, 1, 'cannot tell: judged on files alone');
});

test('a process that never ends cannot hide a stall: it is reported once the live extension is used up', () => {
  const r = rig();
  r.dispatch();
  r.work();
  r.live(true);
  r.run(175);
  assert.deepEqual(r.events, [], 'inside the extension');
  r.run(10);
  assert.equal(r.events.length, 1, 'stalled after the cap');
  assert.match((r.events as WatchEvent[])[0]?.summary ?? '', /^stalled aaaa /);
  assert.match((r.events as WatchEvent[])[0]?.summary ?? '', /pid 4242 \(sleep\).*likely hung.*Do not spare/, 'a capped stall says a process outlived the cap and names it');
  const g = rig();
  g.dispatch();
  g.work();
  g.live(true);
  g.run(60);
  g.live(false);
  g.run(200);
  assert.doesNotMatch((g.events as WatchEvent[])[0]?.summary ?? '', /hung/, 'a process that ended is an ordinary stall');
  r.run(4000);
  assert.equal(r.events.length, 1, 'and reported once');
  r.work();
  r.run(190);
  assert.equal(r.events.length, 2, 'real progress re-arms it, and a forever process does not hide the next stall');
});

test('real io: live() sees a process whose cwd is in the worktree, and dispatchFiles() takes the report and scratch, not the brief', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stall-live-')));
  const io = stall.realIo(home, defaultRun);
  const wt = join(home, 'wt');
  mkdirSync(join(wt, 'sub'), { recursive: true });
  const probe = spawnSync('lsof', ['-v'], { encoding: 'utf8' });
  const hasLsof = !probe.error;
  const child = (await import('node:child_process')).spawn('sleep', ['30'], { cwd: join(wt, 'sub') });
  try {
    await new Promise((res) => setTimeout(res, 300));
    if (hasLsof) {
      assert.equal(io.live(wt, 0), true, 'sleep runs in wt/sub');
    } else assert.equal(io.live(wt, 0), null);
  } finally { child.kill(); }
  if (hasLsof) { await new Promise((res) => setTimeout(res, 300)); assert.equal(io.live(wt, 0), false, 'the process is gone'); }
  if (hasLsof) {
    const sleeper = (await import('node:child_process')).spawn('sleep', ['30'], { cwd: join(wt, 'sub') });
    try {
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(io.live(wt, Date.now() - 60_000), true, 'started after the dispatch: counts');
      assert.equal(io.live(wt, Date.now() + 60_000), false, 'started before the dispatch: a stray tab or proxy, ignored');
    } finally { sleeper.kill(); }
  }
  const failing = stall.realIo(home, () => ({ status: 127, stdout: '', stderr: 'no lsof' }) as never);
  assert.equal(failing.live(wt, 0), null, 'no lsof: unknown, not false');
  const dir = join(home, 'briefs');
  mkdirSync(dir);
  for (const f of ['brief-ab12.md', 'report-ab12.md', 'details-ab12.txt', 'report-zz99.md']) writeFileSync(join(dir, f), f);
  const old = new Date(T0 - 5 * 3600_000);
  for (const f of ['brief-ab12.md', 'report-ab12.md', 'report-zz99.md']) utimesSync(join(dir, f), old, old);
  const got = io.dispatchFiles(join(dir, 'report-ab12.md'), 'ab12');
  assert.equal(got?.what, 'wrote details-ab12.txt', 'the fresh scratch file wins; the brief and another item are ignored');
  assert.equal(io.dispatchFiles(join(dir, 'report-nope.md'), 'nope'), null);
  const other = join(home, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'review-xab12y-other-item.md'), 'x');
  writeFileSync(join(other, 'report-ab123.md'), 'x');
  assert.equal(io.dispatchFiles(join(other, 'report-ab12.md'), 'ab12'), null, 'the id inside a longer word is another name, not this item\'s file');
  writeFileSync(join(other, 'suite-ab12.log'), 'x');
  assert.equal(io.dispatchFiles(join(other, 'report-ab12.md'), 'ab12')?.what, 'wrote suite-ab12.log', 'the id as its own token counts');

});
