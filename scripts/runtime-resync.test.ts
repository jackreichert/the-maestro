// Run: node --test scripts/runtime-resync.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resyncRuntime, runtimeBehind, runtimeWorktree, slugOf, type ResyncDeps, type Run } from './lib/runtime-resync.ts';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

interface Opts { head?: string; main?: string; dirty?: boolean; ancestor?: boolean; ci?: string; kick?: boolean; fetchOk?: boolean }

/** Fake deps that record every git call, every restart and every log line. */
function fake(o: Opts = {}): { deps: ResyncDeps; calls: string[]; kicks: number[]; logs: string[] } {
  const calls: string[] = [];
  const kicks: number[] = [];
  const logs: string[] = [];
  const ok = (stdout = ''): Run => ({ status: 0, stdout });
  const deps: ResyncDeps = {
    git: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'fetch') return { status: o.fetchOk === false ? 1 : 0, stdout: '' };
      if (args[0] === 'rev-parse') return ok(args[1] === 'HEAD' ? (o.head ?? OLD) : (o.main ?? NEW));
      if (args[0] === 'status') return ok(o.dirty ? ' M scripts/journal.ts\n' : '');
      if (args[0] === 'merge-base') return { status: o.ancestor === false ? 1 : 0, stdout: '' };
      return ok();
    },
    ciConclusion: () => ('ci' in o ? o.ci : 'success'),
    kickstart: () => { kicks.push(1); return o.kick !== false; },
    log: (l) => logs.push(l),
  };
  return { deps, calls, kicks, logs };
}

test('a clean pure fast-forward with green CI moves the runtime and restarts the daemon once', () => {
  const f = fake();
  const r = resyncRuntime(f.deps);
  assert.deepEqual(r, { action: 'resynced', old: OLD, new: NEW });
  assert.ok(f.calls.includes(`merge --ff-only ${NEW}`));
  assert.equal(f.kicks.length, 1);
  assert.match(f.logs.join('\n'), /aaaaaaaa -> bbbbbbbb/);
});

test('a non-fast-forward is refused: nothing merged, nothing restarted', () => {
  const f = fake({ ancestor: false });
  const r = resyncRuntime(f.deps);
  assert.equal(r.action, 'refused');
  assert.match(r.reason ?? '', /not a fast-forward/);
  assert.ok(!f.calls.some((c) => c.startsWith('merge ')));
  assert.equal(f.kicks.length, 0);
});

test('red, missing or unreadable CI is refused', () => {
  for (const ci of ['failure', 'cancelled', '', undefined]) {
    const f = fake({ ci });
    const r = resyncRuntime(f.deps);
    assert.equal(r.action, 'refused', String(ci));
    assert.match(r.reason ?? '', /CI test/);
    assert.ok(!f.calls.some((c) => c.startsWith('merge ')));
    assert.equal(f.kicks.length, 0);
  }
});

test('a dirty runtime worktree is refused', () => {
  const f = fake({ dirty: true });
  assert.match(resyncRuntime(f.deps).reason ?? '', /not clean/);
  assert.equal(f.kicks.length, 0);
});

test('already current is a no-op: no CI read, no merge, no restart', () => {
  let ciCalls = 0;
  const f = fake({ head: NEW });
  f.deps.ciConclusion = () => { ciCalls += 1; return 'success'; };
  const r = resyncRuntime(f.deps);
  assert.equal(r.action, 'current');
  assert.equal(ciCalls, 0);
  assert.equal(f.kicks.length, 0);
  assert.ok(!f.calls.some((c) => c.startsWith('merge ')));
});

test('a failed fetch is refused before anything moves', () => {
  const f = fake({ fetchOk: false });
  assert.equal(resyncRuntime(f.deps).action, 'refused');
  assert.equal(f.kicks.length, 0);
});

test('a failed restart after the move is reported as an error, not success', () => {
  const f = fake({ kick: false });
  const r = resyncRuntime(f.deps);
  assert.equal(r.action, 'error');
  assert.match(f.logs.join('\n'), /still the old process/);
});

test('runtimeBehind reports the lag, and null when current', () => {
  const git = (head: string, main: string, n: string) => (args: string[]): Run => ({ status: 0, stdout: args[0] === 'rev-list' ? n : args[1] === 'HEAD' ? head : main });
  assert.deepEqual(runtimeBehind(git(OLD, NEW, '2')), { runtime: OLD, main: NEW, behind: 2 });
  assert.equal(runtimeBehind(git(NEW, NEW, '0')), null);
});

test('runtimeWorktree prefers the env override, else the plist program path', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rr-'));
  const plist = join(dir, 'x.plist');
  writeFileSync(plist, '<array><string>/usr/bin/node</string><string>/work/rt/scripts/loop-supervisor.ts</string></array>');
  assert.equal(runtimeWorktree({}, plist), '/work/rt');
  assert.equal(runtimeWorktree({ MAESTRO_RUNTIME_WORKTREE: '/other' }, plist), '/other');
  assert.equal(runtimeWorktree({}, join(dir, 'missing.plist')), undefined);
});

test('slugOf reads ssh and https GitHub remotes', () => {
  assert.equal(slugOf('git@github.com:acme/widget.git\n'), 'acme/widget');
  assert.equal(slugOf('https://github.com/acme/widget'), 'acme/widget');
  assert.equal(slugOf('/tmp/local'), undefined);
});
