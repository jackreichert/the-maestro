// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/local-branch-class.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
fromBase('feat/live-work');        // live
commit(delta, 'live.txt');
fromBase('local/overlay');         // special
commit(delta, 'o.txt');
sh(delta, 'switch', '-q', 'staging');
for (const f of ['c.txt', 'w.txt', 't.txt']) commit(delta, f, f, `land ${f} on staging`);
commit(delta, 'a.txt', 'base version', 'feat(ABC-12): the landed version');
sh(delta, 'push', '-q', 'origin', 'staging');
sh(delta, 'worktree', 'add', '-q', join(container, '.tree-delta'), 'feat/in-a-tree');

console.log("DBG", container);
const scan = (classCache?: Record<string, never>): ReturnType<typeof scanLocalReview> => scanLocalReview({ containerRoot: container, vault: '', now: NOW, ...(classCache ? { classCache } : {}) });

test('the queue holds live work only; every other class is behind a count', () => {
  const r = scan();
  assert.deepEqual(r.units.map((u) => u.branch), ['feat/live-work']);
  assert.deepEqual({ ...r.cleanup, commands: [] }, { landed: 4, superseded: 1, special: 1, commands: [] });
});

test('the clean-up block names only landed, own, not-checked-out branches, one command a line, no comments', () => {
  const { commands } = scan().cleanup;
  assert.deepEqual(commands, ["git -C 'delta' branch -D 'feat/cancelled'", "git -C 'delta' branch -D 'feat/cherried'"]);
  for (const c of commands) assert.ok(!c.includes('#') && !c.includes('\n'));
});

test('a branch that moves is classified again; one that did not is read from the cache', () => {
  const cache: Record<string, never> = {};
  scan(cache);
  const key = `delta\0feat/live-work`;
  assert.equal((cache as Record<string, { cls: string }>)[key]?.cls, 'live');
  (cache as Record<string, { cls: string }>)[key] = { ...(cache as Record<string, { head: string; base: string; cls: string }>)[key] as { head: string; base: string; cls: string }, cls: 'landed' };
  assert.equal(scan(cache).units.length, 0, 'a cache hit is trusted without asking git again');
  sh(delta, 'switch', '-q', 'feat/live-work'); commit(delta, 'live-2.txt'); sh(delta, 'switch', '-q', 'staging');
  assert.deepEqual(scan(cache).units.map((u) => u.branch), ['feat/live-work'], 'a new tip invalidates the entry');
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
