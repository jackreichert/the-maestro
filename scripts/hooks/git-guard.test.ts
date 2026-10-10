import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, run, isProtected } from './git-guard.ts';
import type { GuardContext } from './git-guard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'git-guard.ts');
// Fake repos by directory: /prot is on main, /dev on develop, /det is a detached HEAD, /bad cannot be read, /al has aliases, anything else is a feature branch.
const ctx = (cwd = '/feat'): GuardContext => ({
  cwd,
  branch: (dir) => (dir === '/prot' ? 'main' : dir === '/det' ? '' : dir === '/bad' ? undefined : dir === '/dev' ? 'develop' : 'feat/x'),
  aliases: (dir): Record<string, string> => (dir === '/al' ? { p: 'push', nuke: '!git reset --hard', fp: 'push --force' } : {}),
});
const asks = (cmd: string, cwd?: string): boolean => decide(cmd, ctx(cwd)).ask;
const hook = (command: string, cwd = '/feat') => JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });

const ASK: [string, string?][] = [
  ['git push origin main'],
  ['git push origin develop'],
  ['git push origin staging'],
  ['git push origin HEAD:main'],
  ['git push origin feat/x:refs/heads/develop'],
  ['git push origin :develop'],
  ['git push', '/prot'],
  ['git push origin', '/prot'],
  ['git push origin HEAD', '/dev'],
  ['git push', '/bad'],
  ['git push --force origin feat/x'],
  ['git push -f origin feat/x'],
  ['git push --force-with-lease'],
  ['git push --force-with-lease=feat/x:abc origin feat/x'],
  ['git push origin +feat/x'],
  ['git push origin +feat/x:feat/x'],
  ['git push --all origin'],
  ['git push --mirror'],
  ['git push origin "refs/heads/*:refs/heads/*"'],
  ['git reset --hard HEAD~1'],
  ['git reset'],
  ['git rebase main'],
  ['git rebase -i HEAD~3'],
  ['git merge origin/main'],
  ['git merge --ff-only origin/main'],
  ['git cherry-pick abc123'],
  ['git revert HEAD'],
  ['git add -A'],
  ['git add --all'],
  ['git add .'],
  ['git add ./'],
  ['git add -f .'],
  ['git commit -a -m wip'],
  ['git commit -am wip'],
  ['git commit -m "x"', '/prot'],
  ['git commit -m "x"', '/bad'],
  ['git branch -D feat/y'],
  ['git branch -d develop'],
  ['git branch -f main HEAD'],
  ['git clean -fd'],
  ['git clean -f'],
  ['git clean --force -x'],
  ['git checkout .'],
  ['git checkout -- src/a.ts'],
  ['git checkout abc123 src/a.ts'],
  ['git checkout -f other'],
  ['git checkout -B other'],
  ['git restore src/a.ts'],
  ['git restore .'],
  ['git restore --worktree --staged x'],
  ['git switch -f other'],
  ['git switch -C other'],
  ['git pull --rebase'],
  ['git pull origin main'],
  // evasions
  ['git -C x push origin develop'],
  ['git -C /prot commit -m x', '/feat'],
  ['git -C /prot push'],
  ['git --no-pager -c color.ui=always push origin main'],
  ['git -c alias.zz=push zz origin main'],
  ['FOO=1 git reset --hard'],
  ['FOO=1 BAR=2 git push -f'],
  ['/usr/bin/git reset --hard'],
  ['env GIT_SSH=x git push --force'],
  ['sudo git reset --hard'],
  ['command git merge x'],
  ['echo a | xargs -n1 git push origin develop'],
  ['bash -c "git push --force"'],
  ["sh -c 'git reset --hard'"],
  ['bash -lc "cd x && git rebase main"'],
  ['bash -c "bash -c \\"git merge x\\""'],
  ['eval "git push origin main"'],
  ['echo hi && git reset --hard'],
  ['git status; git rebase main'],
  ['git status || git merge x'],
  ['git log | cat & git reset --hard'],
  ['git status\ngit reset --hard'],
  ['(git push --force)'],
  ['{ git reset --hard; }'],
  ['if true; then git rebase main; fi'],
  ['echo $(git reset --hard)'],
  ['git push origin @', '/prot'],
  ['git push origin HEAD:$BASE'],
  ['B=main; git push origin $B'],
  ["git push origin $'main'"],
  ['git push origin "$(git branch --show-current)"'],
  ['xargs -I{} git push origin {}'],
  ['git push origin $(git branch --show-current) --force'],
  ['git push $(git remote | head -1) --force'],
  ['git -C $(git rev-parse --show-toplevel) push origin main'],
  ['git -C `pwd` push --force'],
  ['echo "$(git push -f)"'],
  ['echo `git merge x`'],
  ['git push -f 2>&1'],
  ['git push --force > /tmp/out'],
  ['cd /prot && git commit -m x'],
  ['cd /prot; git push'],
  ['git p origin main', '/al'],
  ['git nuke', '/al'],
  ['git fp', '/al'],
  ['git push "origin" "main"'],
  ['git push origin \\\nmain'],
];

const ALLOW: [string, string?][] = [
  ['git status'],
  ['git diff HEAD~1'],
  ['git log --oneline -5'],
  ['git show abc123'],
  ['git fetch origin'],
  ['git ls-remote origin'],
  ['git rev-parse HEAD'],
  ['git blame src/a.ts'],
  ['git branch -d feat/old'],
  ['git branch'],
  ['git branch --list'],
  ['git push'],
  ['git push origin feat/x'],
  ['git push -u origin feat/x'],
  ['git push -u origin HEAD'],
  ['git push origin @'],
  ['git push --tags'],
  ['git push origin feat/x:feat/y'],
  ['git commit -m "tidy"'],
  ['git commit -m "run git push --force and git reset"'],
  ['git commit -m "-a"'],
  ['git commit -m x', '/det'],
  ['git add src/a.ts'],
  ['git add -- src/a.ts src/b.ts'],
  ['git add -p src/a.ts'],
  ['git checkout feat/other'],
  ['git checkout -b feat/new'],
  ['git checkout -b feat/new origin/develop'],
  ['git switch feat/other'],
  ['git switch -c feat/new'],
  ['git restore --staged src/a.ts'],
  ['git clean -n'],
  ['git clean -nd'],
  ['git pull'],
  ['git pull --ff-only'],
  ['git stash'],
  ['echo "git push --force"'],
  ["echo 'git reset --hard'"],
  ['grep -r "git merge" docs/'],
  ['cat notes.txt # git reset --hard'],
  ['git status && git diff | cat'],
  ['git -C other status'],
  ['git -c color.ui=always log'],
  ['FOO=1 git status'],
  ['ls 2>&1 | head'],
  ['npm test'],
  ['cd /feat && git commit -m ok'],
  ['git p origin feat/x', '/al'],
  ['git push origin feat/x', '/prot'],
];

test('commands that need the harness prompt ask', () => {
  for (const [cmd, cwd] of ASK) assert.equal(asks(cmd, cwd), true, `should ask: ${JSON.stringify(cmd)} in ${cwd ?? '/feat'}`);
});

test('read-only verbs, plain feature-branch work and quoted look-alikes pass with no prompt', () => {
  for (const [cmd, cwd] of ALLOW) assert.equal(asks(cmd, cwd), false, `should allow: ${JSON.stringify(cmd)} in ${cwd ?? '/feat'} (${decide(cmd, ctx(cwd)).reasons.join('; ')})`);
});

test('mutation check, protected branches: with develop out of the set a push to it passes, main still asks', () => {
  const probe = `import('${SCRIPT}').then((m) => { const c = { cwd: '/feat', branch: () => 'feat/x', aliases: () => ({}) }; process.stdout.write([m.decide('git push origin develop', c).ask, m.decide('git push origin main', c).ask].join(',')); })`;
  const r = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, GIT_GUARD_PROTECTED: 'main' }, encoding: 'utf8' });
  assert.equal(r.stdout, 'false,true');
  assert.equal(isProtected('develop'), true);
  assert.equal(isProtected('refs/heads/staging'), true);
  assert.equal(isProtected('+main'), true);
  assert.equal(isProtected('feat/main'), false);
});

test('mutation check, force push: each force form asks, and the same push without it passes', () => {
  for (const f of ['--force', '-f', '--force-with-lease', '--force-if-includes']) assert.equal(asks(`git push ${f} origin feat/x`), true, f);
  assert.equal(asks('git push origin +feat/x'), true);
  assert.equal(asks('git push origin feat/x'), false);
  assert.equal(asks('git push --follow-tags origin feat/x'), false);
});

test('the decision is the harness ASK object with a reason, never deny', () => {
  const out = run(hook('git reset --hard'), ctx());
  const parsed = JSON.parse(out.stdout).hookSpecificOutput;
  assert.equal(parsed.hookEventName, 'PreToolUse');
  assert.equal(parsed.permissionDecision, 'ask');
  assert.match(parsed.permissionDecisionReason, /^git-guard: git reset/);
  assert.equal(out.stderr, '');
});

test('other tools and safe commands produce no output', () => {
  assert.deepEqual(run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }), ctx()), { stdout: '', stderr: '' });
  assert.deepEqual(run(hook('git status'), ctx()), { stdout: '', stderr: '' });
});

test('fail-open: an internal error or bad input allows with a stderr note instead of blocking', () => {
  const boom = (): never => { throw new Error('kaboom'); };
  const inner = run(hook('git reset --hard'), ctx(), boom);
  assert.equal(inner.stdout, '');
  assert.match(inner.stderr, /git-guard: could not check this command \(kaboom\); allowing it/);
  const bad = run('not json {', ctx());
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /allowing it/);
  for (const garbage of ['', '{}', 'null', '[]']) assert.equal(run(garbage, ctx()).stdout, '', garbage);
});

test('end to end: the real script exits 0 with a note on garbage input, and asks on a force push', () => {
  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'definitely not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /allowing it/);
  const ok = spawnSync(process.execPath, [SCRIPT], { input: hook('git push --force', '/'), encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('a malformed or unterminated command never throws and is still scanned', () => {
  for (const cmd of ['git push "origin', 'echo $(git reset --hard', 'echo `git merge x', ')))', '((( git status', 'git', '']) assert.doesNotThrow(() => decide(cmd, ctx()), cmd);
  assert.equal(asks('echo $(git reset --hard'), true);
  assert.equal(asks('git push --force "origin'), true);
});

test('real git lookups: a throwaway repo on main asks to commit, on a feature branch it does not, and its own alias is followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-guard-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main', dir]);
    assert.match(run(hook('git commit -m x', dir)).stdout, /protected branch main/);
    spawnSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/feat/z']);
    assert.equal(run(hook('git commit -m x', dir)).stdout, '');
    spawnSync('git', ['-C', dir, 'config', 'alias.go', 'push --force']);
    assert.match(run(hook('git go', dir)).stdout, /force/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
