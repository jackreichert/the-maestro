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

test('toolReadOnly: file readers yes, writers and unknown tools no, Bash by its command', () => {
    assert.deepEqual(['Read', 'Grep', 'Glob', 'WebFetch'].map((n) => toolReadOnly(n)), [true, true, true, true]);
    assert.deepEqual(['Write', 'Edit', 'Agent', 'Skill', 'mcp__x__y'].map((n) => toolReadOnly(n)), [false, false, false, false, false]);
    assert.equal(toolReadOnly('Bash', 'ls'), true);
    assert.equal(toolReadOnly('Bash', 'rm x'), false);
});
