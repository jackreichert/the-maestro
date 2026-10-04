// Run: node --test scripts/pr-open.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const SCRIPT = new URL('./pr-open.ts', import.meta.url).pathname;

const git = (repo: string, ...args: string[]): void => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
};
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `x${i}`).join('\n') + '\n';
const put = (repo: string, path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };

/** A repo with a feature branch holding `files`, plus a fake gh that logs its argv to <repo>/gh.log. */
function fixture(files: Record<string, string>) {
    const repo = mkdtempSync(join(tmpdir(), 'pr-open-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    put(repo, 'README.keep', 'keep\n');
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    for (const [p, t] of Object.entries(files)) put(repo, p, t);
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'change');
    const log = join(tmpdir(), `gh-${Math.random().toString(36).slice(2)}.log`);
    const gh = join(repo, '..', `fake-gh-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(gh, 0o755);
    return { repo, log, gh };
}

const open = ({ repo, gh }: { repo: string; gh: string }, extra: string[] = []) => spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--title', 'T', ...extra], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: repo, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH_BIN: gh },
});

test('over budget refuses, prints the summary and a split hint, and never calls gh', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    const r = open(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /verdict:\s+FAIL/);
    assert.match(r.stderr, /split plan/);
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('code mixed with a lockfile refuses and never calls gh', () => {
    const f = fixture({ 'src/a.py': lines(3), 'uv.lock': lines(50) });
    const r = open(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /mechanical changes go in their own PR/);
    assert.ok(!existsSync(f.log));
});

test('under budget calls gh with --draft and --assignee @me plus the passthrough flags', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    const r = open(f, ['--body-file', 'body.md', '--head', 'feature']);
    assert.equal(r.status, 0, r.stderr);
    const call = readFileSync(f.log, 'utf8').trim();
    assert.equal(call, 'pr create --draft --assignee @me --base main --title T --body-file body.md --head feature');
});

test('draft and assignee cannot be turned off or overridden', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    for (const flag of [['--no-draft'], ['--draft=false'], ['--assignee', 'someone'], ['--ready']]) {
        const r = open(f, flag);
        assert.equal(r.status, 2, flag.join(' '));
    }
    assert.ok(!existsSync(f.log));
});

test('--dry-run prints the gh command and does not run gh; an over-budget dry run still refuses', () => {
    const ok = fixture({ 'src/a.py': lines(10) });
    const r = open(ok, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pr create --draft --assignee @me --base main --title T/);
    assert.ok(!existsSync(ok.log));
    const big = fixture({ 'src/big.py': lines(500) });
    assert.equal(open(big, ['--dry-run']).status, 1);
});
