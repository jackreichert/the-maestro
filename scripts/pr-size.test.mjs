// Run: node --test scripts/pr-size.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const SCRIPT = new URL('./pr-size.mjs', import.meta.url).pathname;
const { globToRegExp, parseNumstat } = await import('./pr-size.mjs');

const git = (repo, ...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
};
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
const put = (repo, path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };

/** A repo with one base commit on `main` holding `base` files, then a feature branch with `change(repo)` committed. */
function repoWith(base, change) {
    const repo = mkdtempSync(join(tmpdir(), 'pr-size-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.hooksPath', '/dev/null'); // throwaway fixture repo: skip any global commit-msg hook
    for (const [p, t] of Object.entries(base)) put(repo, p, t);
    put(repo, 'README.keep', 'keep\n');
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    change(repo);
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'change');
    return repo;
}

/** Runs the CLI hermetically (no user config file); returns { code, out, json }. */
function check(repo, env = {}, extra = []) {
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', ...extra], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: repo, MAESTRO_LOCAL_CONFIG: '', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const checkJson = (repo, env) => { const r = check(repo, env, ['--json']); return { status: r.code, ...JSON.parse(r.out) }; };

test('under budget passes and prints the summary', () => {
    const repo = repoWith({}, (r) => { put(r, 'src/a.py', lines(10)); put(r, 'src/b.py', lines(10)); });
    const r = check(repo);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /code:\s+2 files, 20 lines/);
    assert.match(r.out, /verdict:\s+PASS/);
});

test('over on files: six code files fail even when tiny', () => {
    const repo = repoWith({}, (r) => { for (let i = 0; i < 6; i++) put(r, `src/f${i}.py`, lines(1)); });
    const r = checkJson(repo);
    assert.equal(r.status, 1);
    assert.match(r.failures.join('\n'), /6 code files \(max 5\)/);
    assert.doesNotMatch(r.failures.join('\n'), /code lines/);
});

test('over on lines: one big file fails, additions plus deletions both count', () => {
    const repo = repoWith({ 'src/big.py': lines(250, 'old') }, (r) => put(r, 'src/big.py', lines(250, 'new')));
    const r = checkJson(repo);
    assert.equal(r.status, 1);
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.failures.join('\n'), /500 code lines \(max 400\)/);
    assert.doesNotMatch(r.failures.join('\n'), /code files/);
});

test('tests, config and docs are not counted', () => {
    const repo = repoWith({}, (r) => {
        put(r, 'src/a.py', lines(5));
        for (let i = 0; i < 6; i++) put(r, `tests/test_${i}.py`, lines(300));
        put(r, 'pkg/app.test.ts', lines(100));
        put(r, 'settings.json', lines(100)); put(r, 'deploy.yaml', lines(100)); put(r, 'ci.yml', lines(50));
        put(r, 'tool.toml', lines(50)); put(r, 'setup.ini', lines(50));
        put(r, 'Dockerfile', lines(50)); put(r, '.github/workflows/ci.yml', lines(50));
        put(r, 'NOTES.md', lines(300));
    });
    const r = checkJson(repo);
    assert.equal(r.status, 0);
    assert.equal(r.code.files, 1);
    assert.equal(r.tests.files, 7);
    assert.equal(r.config.files, 7);
    assert.equal(r.docs.files, 1);
    assert.equal(r.verdict, 'PASS');
});

test('a lockfile-only PR passes, whatever its size', () => {
    const repo = repoWith({}, (r) => { put(r, 'uv.lock', lines(5000)); put(r, 'package-lock.json', lines(5000)); put(r, 'pnpm-lock.yaml', lines(10)); put(r, 'yarn.lock', lines(10)); });
    const r = checkJson(repo);
    assert.equal(r.status, 0);
    assert.equal(r.mechanical.files, 4);
    assert.equal(r.verdict, 'PASS');
});

test('lockfile plus code fails as mixed, with its own message', () => {
    const repo = repoWith({}, (r) => { put(r, 'src/a.py', lines(3)); put(r, 'uv.lock', lines(100)); });
    const r = checkJson(repo);
    assert.equal(r.status, 1);
    assert.deepEqual(r.failures, ['mechanical changes go in their own PR']);
});

test('a migration counts as code, including .sql under a migrations dir', () => {
    const repo = repoWith({}, (r) => {
        put(r, 'db/migrations/001_add.sql', lines(450));
        put(r, 'app/migrations/0002_x.py', lines(1));
    });
    const r = checkJson(repo);
    assert.equal(r.status, 1);
    assert.match(r.failures.join('\n'), /451 code lines/);
});

test('a pure rename is exempt; a rename with edits counts', () => {
    const body = lines(300);
    const repo = repoWith({ 'src/old_name.py': body, 'src/other.py': body }, (r) => {
        renameSync(join(r, 'src/old_name.py'), join(r, 'src/new_name.py'));
        renameSync(join(r, 'src/other.py'), join(r, 'src/moved.py'));
        writeFileSync(join(r, 'src/moved.py'), body + lines(2, 'edit'));
    });
    const r = checkJson(repo);
    assert.equal(r.mechanical.files, 1);
    assert.deepEqual(r.mechanical.paths, ['src/new_name.py']);
    assert.match(r.failures.join('\n'), /mechanical changes go in their own PR/);
    assert.deepEqual(r.code.paths, ['src/moved.py']);
});

test('a rename-only PR passes', () => {
    const repo = repoWith({ 'src/a.py': lines(300) }, (r) => renameSync(join(r, 'src/a.py'), join(r, 'src/b.py')));
    assert.equal(check(repo).code, 0);
});

test('limits come from the environment and from the config file; env wins', () => {
    const repo = repoWith({}, (r) => { for (let i = 0; i < 3; i++) put(r, `src/f${i}.py`, lines(50)); });
    assert.equal(check(repo).code, 0);
    assert.equal(check(repo, { MAESTRO_PR_MAX_CODE_FILES: '2' }).code, 1);
    assert.equal(check(repo, { MAESTRO_PR_MAX_CODE_LINES: '100' }).code, 1);
    assert.equal(check(repo, { MAESTRO_PR_MAX_CODE_FILES: '3', MAESTRO_PR_MAX_CODE_LINES: '150' }).code, 0);
    const cfg = join(repo, 'cfg.md');
    writeFileSync(cfg, '```maestro-config\npr_max_code_files: 2\n```\n');
    assert.equal(check(repo, { MAESTRO_LOCAL_CONFIG: cfg }).code, 1);
    assert.equal(check(repo, { MAESTRO_LOCAL_CONFIG: cfg, MAESTRO_PR_MAX_CODE_FILES: '9' }).code, 0);
});

test('glob settings replace the defaults: a custom test glob excludes, a custom mechanical glob exempts', () => {
    const repo = repoWith({}, (r) => { put(r, 'checks/a.py', lines(500)); put(r, 'snap/out.dat', lines(500)); });
    assert.equal(check(repo).code, 1);
    assert.equal(check(repo, { MAESTRO_PR_TEST_GLOBS: 'checks/**' }).code, 1, 'the .dat file still counts as code');
    assert.equal(check(repo, { MAESTRO_PR_TEST_GLOBS: 'checks/**', MAESTRO_PR_CONFIG_GLOBS: 'snap/**' }).code, 0);
    const onlyDat = repoWith({}, (r) => put(r, 'snap/out.dat', lines(500)));
    assert.equal(check(onlyDat).code, 1);
    assert.equal(check(onlyDat, { MAESTRO_PR_MECHANICAL_GLOBS: '*.dat' }).code, 0);
});

test('bad usage and unknown refs exit 2', () => {
    const repo = repoWith({}, (r) => put(r, 'src/a.py', lines(1)));
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
    assert.equal(check(repo, {}, ['--head', 'nope']).code, 2);
});

test('globToRegExp and parseNumstat basics', () => {
    assert.ok(globToRegExp('*.lock').test('a/b/uv.lock'));
    assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
    assert.ok(!globToRegExp('docs/**').test('src/docs.md'));
    assert.ok(globToRegExp('**/tests/**').test('a/tests/x.py'));
    assert.ok(globToRegExp('**/tests/**').test('tests/x.py'));
    const f = parseNumstat(['1\t2\tsrc/a.py', '-\t-\tlogo.png', '0\t0\t', 'old.py', 'new.py', ''].join('\0'));
    assert.deepEqual(f.map((x) => [x.path, x.added, x.deleted, x.renamed]), [['src/a.py', 1, 2, false], ['logo.png', 0, 0, false], ['new.py', 0, 0, true]]);
});
