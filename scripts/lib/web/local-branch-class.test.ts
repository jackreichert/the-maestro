// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/local-branch-class.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classCacheFile, readClassCache, writeClassCache } from './local-review-cache.ts';
import { scanLocalReview } from './local-review.ts';

const NOW = new Date('2026-10-13T15:00:00Z');
const tmp = mkdtempSync(join(tmpdir(), 'local-class-'));
const container = join(tmp, 'container');
const ME = 'me@example.com';
const sh = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: ME } }).trim();
const commit = (cwd: string, file: string, body = file, msg = `add ${file}`, author = ME): void => {
  writeFileSync(join(cwd, file), body); sh(cwd, 'add', file); sh(cwd, 'commit', '-q', '-m', msg, '--author', `t <${author}>`);
};

// Fixture repo "delta" with a base on staging and one local-only branch per class.
const origin = join(tmp, 'origin.git');
mkdirSync(container, { recursive: true });
sh(tmp, 'init', '-q', '--bare', '-b', 'staging', origin);
const delta = join(container, 'delta');
sh(tmp, 'clone', '-q', origin, delta);
sh(delta, 'config', 'user.email', ME);
commit(delta, 'base.txt');
sh(delta, 'push', '-q', 'origin', 'staging');
const fromBase = (name: string): void => { sh(delta, 'switch', '-q', 'staging'); sh(delta, 'switch', '-q', '-c', name); };

fromBase('feat/cherried');         // landed: the same patch reaches staging under another sha
commit(delta, 'c.txt');
fromBase('feat/cancelled');        // landed: its commits cancel out, so it touches nothing new
commit(delta, 'x.txt'); sh(delta, 'rm', '-q', 'x.txt'); sh(delta, 'commit', '-q', '-m', 'drop x');
fromBase('feat/theirs');           // landed, but a colleague wrote it: counted, never in the delete block
commit(delta, 't.txt', 't.txt', 'add t.txt', 'other@example.com');
fromBase('feat/in-a-tree');        // landed but checked out: counted, never in the delete block
commit(delta, 'w.txt');
fromBase('feat/ABC-12-rework');    // superseded: base carries a commit naming ABC-12, with different content
commit(delta, 'a.txt', 'branch version');
fromBase('feat/café-éclair');      // live: a non-ASCII file name must not read as "unchanged"
commit(delta, 'café.md');
fromBase('feat/live-work');        // live
commit(delta, 'live.txt');
fromBase('local/overlay');         // special
commit(delta, 'o.txt');
sh(delta, 'switch', '-q', 'staging');
for (const f of ['c.txt', 'w.txt', 't.txt']) commit(delta, f, f, `land ${f} on staging`);
commit(delta, 'a.txt', 'base version', 'feat(ABC-12): the landed version');
sh(delta, 'push', '-q', 'origin', 'staging');
sh(delta, 'worktree', 'add', '-q', join(container, '.tree-delta'), 'feat/in-a-tree');

const scan = (classCache?: Record<string, never>): ReturnType<typeof scanLocalReview> => scanLocalReview({ containerRoot: container, vault: '', now: NOW, ...(classCache ? { classCache } : {}) });

test('the queue holds live work only; every other class is behind a count', () => {
  const r = scan();
  assert.deepEqual(r.units.map((u) => u.branch).sort(), ['feat/café-éclair', 'feat/live-work']);
  assert.deepEqual({ ...r.cleanup, commands: [] }, { landed: 4, superseded: 1, special: 1, commands: [] });
});

test('the clean-up block names only landed, own, not-checked-out branches, one command a line, no comments', () => {
  const { commands } = scan().cleanup;
  const tip = (b: string): string => sh(delta, 'rev-parse', b);
  assert.deepEqual(commands, [`git -C 'delta' update-ref -d 'refs/heads/feat/cancelled' ${tip('feat/cancelled')}`, `git -C 'delta' update-ref -d 'refs/heads/feat/cherried' ${tip('feat/cherried')}`]);
  for (const c of commands) assert.ok(!c.includes('#') && !c.includes('\n'));
});

test('a branch that moves is classified again; one that did not is read from the cache', () => {
  const cache: Record<string, never> = {};
  scan(cache);
  const key = `delta\0feat/live-work`;
  assert.equal((cache as Record<string, { cls: string }>)[key]?.cls, 'live');
  (cache as Record<string, { cls: string }>)[key] = { ...(cache as Record<string, { head: string; base: string; cls: string }>)[key] as { head: string; base: string; cls: string }, cls: 'landed' };
  assert.equal(scan(cache).units.some((u) => u.branch === 'feat/live-work'), false, 'a cache hit is trusted without asking git again');
  sh(delta, 'switch', '-q', 'feat/live-work'); commit(delta, 'live-2.txt'); sh(delta, 'switch', '-q', 'staging');
  assert.ok(scan(cache).units.some((u) => u.branch === 'feat/live-work'), 'a new tip invalidates the entry');
});

test('the cache drops branches that are gone and survives a round trip through its file', () => {
  const cache: Record<string, never> = {};
  scan(cache);
  (cache as Record<string, unknown>)['delta\0gone'] = { head: 'x', base: 'y', cls: 'live' };
  scan(cache);
  assert.equal('delta\0gone' in cache, false);
  const file = classCacheFile(join(tmp, 'snap', 'local-review.json'));
  writeClassCache(file, cache);
  assert.deepEqual(readClassCache(file), JSON.parse(readFileSync(file, 'utf8')));
  assert.deepEqual(readClassCache(join(tmp, 'missing.json')), {});
});

test('a scan that runs out of time keeps everything live and offers nothing for deletion', () => {
  const r = scanLocalReview({ containerRoot: container, vault: '', now: NOW, budgetMs: 1 });
  assert.deepEqual(r.cleanup.commands, []);
  assert.equal(r.cleanup.landed, 0);
});

// Fail-open cases from review: content git cherry or a blob-only compare cannot see.
const put = (cwd: string, f: string, body: string): void => { writeFileSync(join(cwd, f), body); sh(cwd, 'add', f); };
const origin2 = join(tmp, 'o2.git');
const container2 = join(tmp, 'c2');
mkdirSync(container2, { recursive: true });
sh(tmp, 'init', '-q', '--bare', '-b', 'staging', origin2);
const r = join(container2, 'repo');
sh(tmp, 'clone', '-q', origin2, r);
sh(r, 'config', 'user.email', ME);
put(r, 'base.txt', 'b\n'); put(r, 'old.ts', 'code\n'); put(r, 'run.sh', 'echo\n'); sh(r, 'commit', '-qm', 'base');
sh(r, 'push', '-q', 'origin', 'staging');
const from = (n: string): void => { sh(r, 'switch', '-q', 'staging'); sh(r, 'switch', '-q', '-c', n); };

// 1. Evil merge: the only new content is inside a merge commit; git cherry skips merges.
from('feat/side'); put(r, 'side.txt', 's\n'); sh(r, 'commit', '-qm', 'side');
from('feat/evil-merge');
sh(r, 'merge', '-q', '--no-ff', '--no-commit', 'feat/side');
put(r, 'secret-work.txt', 'unmerged work\n'); sh(r, 'commit', '-qm', 'merge side plus my work');
// 2. Rename whose deletion half is unmerged: base gained a copy at the new path but kept the old one.
from('feat/move'); sh(r, 'mv', 'old.ts', 'new.ts'); sh(r, 'commit', '-qm', 'move old.ts to new.ts');
// 3. Mode-only change: chmod +x is the whole branch.
from('feat/chmod'); chmodSync(join(r, 'run.sh'), 0o755); sh(r, 'add', 'run.sh'); sh(r, 'commit', '-qm', 'make run.sh executable');
sh(r, 'switch', '-q', 'staging');
put(r, 'side.txt', 's\n'); sh(r, 'commit', '-qm', 'land side');
put(r, 'new.ts', 'code\n'); sh(r, 'commit', '-qm', 'copy old.ts to new.ts, keep old.ts for now');
sh(r, 'push', '-q', 'origin', 'staging');
sh(r, 'branch', '-q', '-D', 'feat/side');

const deleted = (): string[] => scanLocalReview({ containerRoot: container2, vault: '', now: new Date() }).cleanup.commands;

for (const b of ['feat/evil-merge', 'feat/move', 'feat/chmod']) {
  test(`${b} has content not on the base (merge, rename or mode only), so it is never in the delete block`, () => {
    assert.ok(!deleted().some((c) => c.includes(`'${b}'`)), deleted().join('\n'));
  });
}

test('a landed branch is deleted by tip: update-ref refuses once the branch has moved', () => {
  const [cmd] = scan().cleanup.commands;
  assert.match(cmd ?? '', /update-ref -d 'refs\/heads\/[^']+' [0-9a-f]{40}$/);
});
