// Run: node --test scripts/lib/self-update.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, gitIn } from './self-update.ts';

const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const sh = (cwd: string, ...a: string[]): string => {
  const r = spawnSync('git', [...ID, ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (repo: string, file: string, text: string): void => { writeFileSync(join(repo, file), text); sh(repo, 'add', '--', file); sh(repo, 'commit', '-q', '-m', `edit ${file}`); };

/** An origin, a clone of it (the "skill checkout") and a second clone that pushes to origin. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'selfupd-'));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), skill = join(root, 'skill'), pusher = join(root, 'pusher');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, seed); commit(seed, 'a.txt', '1'); sh(seed, 'branch', '-M', 'main'); sh(seed, 'push', '-q', '-u', 'origin', 'main');
  sh(root, 'clone', '-q', origin, skill);
  sh(root, 'clone', '-q', origin, pusher);
  const publish = (file: string, text: string): void => { commit(pusher, file, text); sh(pusher, 'push', '-q', 'origin', 'main'); };
  return { root, origin, skill, pusher, publish };
}

test('a current checkout is silent', () => {
  const w = world();
  const r = checkForUpdate({ repo: w.skill, autoPull: true });
  assert.deepEqual([r.state, r.line], ['current', '']);
});

test('behind is reported with the count and the fix, and nothing is pulled when auto_pull is off', () => {
  const w = world(); w.publish('b.txt', '2'); w.publish('c.txt', '3');
  const before = sh(w.skill, 'rev-parse', 'HEAD');
  const r = checkForUpdate({ repo: w.skill, autoPull: false });
  assert.equal(r.state, 'behind');
  assert.match(r.line, /2 commit\(s\) behind origin\/main.*git pull --ff-only.*auto_pull/);
  assert.equal(sh(w.skill, 'rev-parse', 'HEAD'), before, 'report only');
});

test('auto_pull fast-forwards a clean, purely-behind checkout', () => {
  const w = world(); w.publish('b.txt', '2');
  const r = checkForUpdate({ repo: w.skill, autoPull: true });
  assert.equal(r.state, 'pulled');
  assert.match(r.line, /fast-forwarded 1 commit\(s\) from origin\/main/);
  assert.ok(existsSync(join(w.skill, 'b.txt')));
  assert.equal(checkForUpdate({ repo: w.skill, autoPull: true }).line, '', 'idempotent: the next check is silent');
});

test('auto_pull leaves a dirty checkout alone and says so; untracked files count as dirty', () => {
  const w = world(); w.publish('b.txt', '2');
  writeFileSync(join(w.skill, 'scratch.txt'), 'wip');
  const before = sh(w.skill, 'rev-parse', 'HEAD');
  const r = checkForUpdate({ repo: w.skill, autoPull: true });
  assert.equal(r.state, 'behind');
  assert.match(r.line, /Uncommitted changes\. Commit or stash/);
  assert.equal(sh(w.skill, 'rev-parse', 'HEAD'), before);
  assert.match(checkForUpdate({ repo: w.skill, autoPull: false }).line, /behind/);
});

test('diverged is reported and never merged, rebased or reset, even with auto_pull on', () => {
  const w = world(); w.publish('b.txt', '2'); commit(w.skill, 'local.txt', 'mine');
  const before = sh(w.skill, 'rev-parse', 'HEAD');
  const r = checkForUpdate({ repo: w.skill, autoPull: true });
  assert.equal(r.state, 'diverged');
  assert.match(r.line, /diverged from origin\/main \(1 ahead, 1 behind\)/);
  assert.equal(sh(w.skill, 'rev-parse', 'HEAD'), before);
});

test('ahead and dirty-but-in-sync are reported; clean in sync is not', () => {
  const w = world(); commit(w.skill, 'local.txt', 'mine');
  assert.match(checkForUpdate({ repo: w.skill, autoPull: true }).line, /1 commit\(s\) ahead of origin\/main, not pushed/);
  const v = world(); writeFileSync(join(v.skill, 'a.txt'), 'edited');
  const r = checkForUpdate({ repo: v.skill, autoPull: true });
  assert.equal(r.state, 'dirty');
  assert.match(r.line, /uncommitted changes/);
});

test('not a repository, or no upstream, is silent; an unreachable origin is reported rather than hidden', () => {
  const w = world();
  assert.equal(checkForUpdate({ repo: mkdtempSync(join(tmpdir(), 'selfupd-plain-')), autoPull: true }).line, '');
  sh(w.skill, 'checkout', '-q', '-b', 'topic');
  assert.equal(checkForUpdate({ repo: w.skill, autoPull: true }).line, '', 'a branch with no upstream has nothing to compare');
  sh(w.skill, 'checkout', '-q', 'main');
  rmSync(w.origin, { recursive: true });
  const r = checkForUpdate({ repo: w.skill, autoPull: true });
  assert.equal(r.state, 'unchecked');
  assert.match(r.line, /could not fetch origin\/main/);
});

test('the only git commands run are read-only ones, fetch, and merge --ff-only', () => {
  const w = world(); w.publish('b.txt', '2');
  const seen: string[][] = [];
  const real = gitIn(w.skill);
  checkForUpdate({ repo: w.skill, autoPull: true, git: (args, t) => { seen.push(args); return real(args, t); } });
  const verbs = seen.map((a) => a.join(' '));
  assert.ok(verbs.includes('merge --ff-only @{u}'));
  for (const v of verbs) assert.doesNotMatch(v, /^(rebase|reset|checkout|pull|merge(?! --ff-only))/);
});

const NUDGE = /^the-maestro: auto_pull is not set\. To keep this checkout current, set "auto_pull: on" in ~\/\.config\/the-maestro\/config\.md \(or MAESTRO_AUTO_PULL=on\)\. It only fast-forwards a clean, purely-behind checkout; it never merges, rebases or resets\. Set "auto_pull: off" to silence this\.$/;

test('an unanswered auto_pull adds the nudge beside the update line, current or not; answered (on or off) or unspecified adds none', () => {
  const w = world();
  assert.match(checkForUpdate({ repo: w.skill, autoPull: false, autoPullSet: false }).nudge, NUDGE);
  assert.equal(checkForUpdate({ repo: w.skill, autoPull: false, autoPullSet: false }).line, '', 'the update line is independent of the nudge');
  w.publish('b.txt', '2');
  const behind = checkForUpdate({ repo: w.skill, autoPull: false, autoPullSet: false });
  assert.match(behind.line, /1 commit\(s\) behind/);
  assert.match(behind.nudge, NUDGE);
  assert.equal(checkForUpdate({ repo: w.skill, autoPull: false, autoPullSet: true }).nudge, '', 'off, once chosen, is silent');
  assert.equal(checkForUpdate({ repo: w.skill, autoPull: true, autoPullSet: true }).nudge, '');
  assert.equal(checkForUpdate({ repo: w.skill, autoPull: false }).nudge, '', 'callers that do not pass autoPullSet get no nudge');
});

test('the nudge is silent where the update check is: not a repository, no upstream; it still shows when the fetch fails', () => {
  const w = world();
  const ask = { autoPull: false, autoPullSet: false };
  assert.equal(checkForUpdate({ repo: mkdtempSync(join(tmpdir(), 'selfupd-plain-')), ...ask }).nudge, '');
  sh(w.skill, 'checkout', '-q', '-b', 'topic');
  assert.equal(checkForUpdate({ repo: w.skill, ...ask }).nudge, '');
  sh(w.skill, 'checkout', '-q', 'main');
  rmSync(w.origin, { recursive: true });
  const r = checkForUpdate({ repo: w.skill, ...ask });
  assert.match(r.line, /could not fetch/);
  assert.match(r.nudge, NUDGE);
});
