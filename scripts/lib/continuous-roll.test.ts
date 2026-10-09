import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { continuityLines, dirtyPaths, hitMarker, newestHandoff, snapshotDirty, unledgeredDecisions, userMessages } from './continuous-roll.ts';

const line = (o: object): string => JSON.stringify(o);
const T0 = '2026-10-09T12:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

test('userMessages keeps typed text and drops tool results, meta rows and injected tags', () => {
  const t = [
    line({ type: 'user', timestamp: at(0), message: { content: 'always use drafts' } }),
    line({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    line({ type: 'user', timestamp: at(2), isMeta: true, message: { content: 'meta' } }),
    line({ type: 'user', timestamp: at(3), message: { content: '<command-name>/x</command-name>' } }),
    line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'text', text: 'ok to push' }] } }),
    'not json "user"',
  ].join('\n');
  assert.deepEqual(userMessages(t).map((m) => m.text), ['always use drafts', 'ok to push']);
});

test('a decision with no covering row is raised once; a covering row or an earlier hit suppresses it', () => {
  const msgs = [{ ts: at(0), text: 'from now on never merge without a green suite' }, { ts: at(60), text: 'what time is it right now?' }];
  assert.equal(unledgeredDecisions(msgs, [], '').length, 1);
  assert.equal(unledgeredDecisions(msgs, [{ kind: 'rule', ts: at(5), text: 'merge needs green' }], '').length, 0);
  assert.equal(unledgeredDecisions(msgs, [{ kind: 'rule', ts: at(45), text: 'too late to count' }], '').length, 1);
  assert.equal(unledgeredDecisions(msgs, [{ kind: 'ask', ts: at(70), text: `unledgered decision? ${hitMarker(at(0))} x` }], '').length, 0);
  assert.equal(unledgeredDecisions(msgs, [], at(0)).length, 0, 'messages at or before the last compaction are not re-raised');
});

test('a decision message that carries a secret shape is withheld, not quoted', () => {
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const [q] = unledgeredDecisions([{ ts: at(0), text: `always use this key ${key}` }], [], '');
  assert.match(q, /withheld/);
  assert.ok(!q.includes(key));
});

test('dirtyPaths reads porcelain -z: renames consume their source, deletions are dropped', () => {
  assert.deepEqual(dirtyPaths(' M a.ts\0?? b/c.ts\0R  new.ts\0old.ts\0 D gone.ts\0'), ['a.ts', 'b/c.ts', 'new.ts']);
});

function repoWithDirt(): { container: string; wt: string } {
  const container = mkdtempSync(join(tmpdir(), 'cr-'));
  const wt = join(container, '.worktrees', 'w1');
  mkdirSync(wt, { recursive: true });
  const git = (...a: string[]): void => { assert.equal(spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).status, 0); };
  git('init', '-q');
  writeFileSync(join(wt, 'tracked.ts'), 'export const a = 1;\n');
  git('add', 'tracked.ts');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(wt, 'tracked.ts'), 'export const a = 2;\n');
  writeFileSync(join(wt, 'new.ts'), 'export const b = 1;\n');
  writeFileSync(join(wt, '.env.local'), 'X=1\n');
  writeFileSync(join(wt, 'leak.txt'), `token ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}\n`);
  return { container, wt };
}

test('snapshotDirty copies modified and untracked source, skips secret names and secret shapes, and is idempotent', () => {
  const { container } = repoWithDirt();
  const dest = join(container, 'snap');
  const r = snapshotDirty(container, dest);
  assert.deepEqual({ worktrees: r.worktrees, files: r.files, skipped: r.skipped }, { worktrees: 1, files: 2, skipped: 2 });
  assert.equal(readFileSync(join(dest, 'w1', 'tracked.ts'), 'utf8'), 'export const a = 2;\n');
  assert.ok(existsSync(join(dest, 'w1', 'new.ts')));
  assert.ok(!existsSync(join(dest, 'w1', '.env.local')) && !existsSync(join(dest, 'w1', 'leak.txt')));
  assert.equal(snapshotDirty(container, dest).files, 2);
});

test('snapshotDirty leaves a worktree whose dirt is older than 72 hours', () => {
  const { container, wt } = repoWithDirt();
  const old = new Date(Date.now() - 100 * 3_600_000);
  for (const f of ['tracked.ts', 'new.ts', '.env.local', 'leak.txt']) utimesSync(join(wt, f), old, old);
  assert.equal(snapshotDirty(container, join(container, 'snap')).worktrees, 0);
});

test('newestHandoff prefers the generated_at marker and falls back to mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ho-'));
  assert.equal(newestHandoff(dir), null);
  writeFileSync(join(dir, 'HANDOFF-2026-10-09-all.md'), `---\ngenerated_at: ${at(0)}\n---\n`);
  writeFileSync(join(dir, 'HANDOFF-2026-10-09b-all.md'), `---\ngenerated_at: ${at(30)}\n---\n`);
  assert.deepEqual(newestHandoff(dir), { name: 'HANDOFF-2026-10-09b-all.md', at: at(30) });
});

test('continuityLines: silent with no marker or a fresh handoff, loud on an incomplete marker or a stale handoff', () => {
  const work = { kind: 'wip', ts: at(10), text: 'work' };
  const mark = { kind: 'note', ts: at(20), text: 'precompact: handoff delta written' };
  assert.deepEqual(continuityLines([work], null), []);
  assert.deepEqual(continuityLines([work, mark], { name: 'h.md', at: at(15) }), []);
  const stale = continuityLines([work, mark], { name: 'h.md', at: at(5) });
  assert.match(stale[0], /^!! HANDOFF STALE: the newest handoff \(h\.md/);
  assert.match(continuityLines([work, mark], null)[0], /there is no handoff/);
  const raised = { kind: 'question', ts: at(19), used: ['hook:precompact'], text: 'unledgered decision? x' };
  assert.deepEqual(continuityLines([work, raised, mark], { name: 'h.md', at: at(15) }), [], 'asks the hook raised after its handoff are not missed work');
  const bad = { kind: 'note', ts: at(20), text: 'precompact incomplete: handoff: boom (trigger auto)' };
  const lines = continuityLines([work, bad], { name: 'h.md', at: at(15) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^!! precompact incomplete: handoff: boom/);
  const healed = [work, bad, { kind: 'note', ts: at(30), text: 'precompact: handoff delta written' }];
  assert.deepEqual(continuityLines(healed, { name: 'h.md', at: at(29) }), []);
});
