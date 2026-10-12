// Run: node --test scripts/lib/tool-class.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashReadOnly, toolReadOnly } from './tool-class.ts';

test('read-only Bash: reads and read-only git/gh pass, including pipes and a cd prefix', () => {
    for (const c of ['ls -la', 'cd x && git log --oneline | head -5', 'grep -rn foo . 2>&1', 'FOO=1 cat a b', 'gh pr view 1 --json state', 'find . -name "*.ts" 2>/dev/null | wc -l']) {
        assert.equal(bashReadOnly(c), true, c);
    }
});

test('read-only Bash: writes, redirects, find -exec, sed -i and unknown commands fail', () => {
    for (const c of ['rm -rf x', 'echo hi > f', 'cat a >> b', 'git commit -m x', 'git push', 'find . -delete', 'find . -exec rm {} +', 'sed -i s/a/b/ f', 'ls | tee out', 'npm install', '']) {
        assert.equal(bashReadOnly(c), false, c);
    }
});

test('read-only Bash: sed -n, git -C and the read-only plumbing, quoted pipes, for loops and read-only xargs pass (MAESTRO-224)', () => {
  for (const c of [
    "sed -n '1,40p' file.ts", 'git -C /some/repo log --oneline -5', 'git ls-tree -r HEAD', 'git merge-base main HEAD', 'git worktree list',
    'git for-each-ref --format=%(refname)', "grep -E 'a|b' file | head", 'grep -rn "x|y" . | wc -l', 'echo "a > b"',
    'for f in a b; do cat $f; done', 'grep -n x \\\n  file.ts', "awk '{print $1}' f", 'set -e; ls', 'git ls-files | xargs wc -l', 'find . -name x | xargs grep -l foo',
  ]) assert.equal(bashReadOnly(c), true, c);
});

test('read-only Bash: still refused: sed without -n, xargs of a write, a write inside a loop, substitution, a real redirect after a quote', () => {
  for (const c of ['sed s/a/b/ f', 'git ls-files | xargs rm', 'for f in a b; do rm $f; done', 'cat $(rm x)', 'echo "x" > out', 'git -C r push', 'git worktree add x', 'git branch -D x', 'echo "$(rm x)"']) {
    assert.equal(bashReadOnly(c), false, c);
  }
});

test('toolReadOnly: the handback is read-only, so a run that only reads and hands back is a read-only run', () => {
  assert.equal(toolReadOnly('SubagentHandback'), true);
});

test('toolReadOnly: file readers yes, writers and unknown tools no, Bash by its command', () => {
    assert.deepEqual(['Read', 'Grep', 'Glob', 'WebFetch'].map((n) => toolReadOnly(n)), [true, true, true, true]);
    assert.deepEqual(['Write', 'Edit', 'Agent', 'Skill', 'mcp__x__y'].map((n) => toolReadOnly(n)), [false, false, false, false, false]);
    assert.equal(toolReadOnly('Bash', 'ls'), true);
    assert.equal(toolReadOnly('Bash', 'rm x'), false);
});
