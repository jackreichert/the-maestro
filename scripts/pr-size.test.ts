// Run: node --test scripts/pr-size.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Assessment } from './pr-size.ts';

const SCRIPT = new URL('./pr-size.ts', import.meta.url).pathname;
const { globToRegExp, parseNumstat, makeClassifier } = await import('./pr-size.ts');

const git = (repo: string, ...args: string[]): string => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
};
const lines = (n: number, tag = 'x'): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
const put = (repo: string, path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };

/** A repo with one base commit on `main` holding `base` files, then a feature branch with `change(repo)` committed. */
function repoWith(base: Record<string, string>, change: (repo: string) => void): string {
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
function check(repo: string, env: Record<string, string> = {}, extra: string[] = []) {
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', ...extra], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: repo, MAESTRO_LOCAL_CONFIG: '', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const checkJson = (repo: string, env?: Record<string, string>) => {
    const r = check(repo, env, ['--json']);
    const parsed: Assessment = JSON.parse(r.out);
    return { status: r.code, ...parsed };
};

const many = (n: number, each: number) => (r: string) => { for (let i = 0; i < n; i++) put(r, `src/f${i}.py`, lines(each)); };

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

const WIDE = { MAESTRO_PR_WIDE_MAX_CODE_FILES: '10' };

test('wide tier is off by default: output and verdicts match the two-limit gate', () => {
    const repo = repoWith({}, many(6, 1));
    const r = checkJson(repo);
    assert.equal(r.status, 1);
    assert.deepEqual(r.failures, ['over budget: 6 code files (max 5)']);
    assert.deepEqual(r.limits, { maxFiles: 5, maxLines: 400 });
    assert.equal('tier' in r, false);
    assert.doesNotMatch(check(repo).out, /tier|wide/);
    assert.equal(check(repoWith({}, many(6, 22))).code, 1, 'six small files fail with no settings');
    assert.equal(check(repoWith({}, many(5, 80))).code, 0, 'five files at 400 lines still pass');
    assert.equal(check(repoWith({}, many(5, 81))).code, 1);
    // setting only the wide line limit, or a wide file limit at or below the normal one, changes nothing
    assert.equal(check(repo, { MAESTRO_PR_WIDE_MAX_CODE_LINES: '300' }).code, 1);
    assert.equal(check(repo, { MAESTRO_PR_WIDE_MAX_CODE_FILES: '5' }).code, 1);
    assert.equal(check(repo, { MAESTRO_PR_WIDE_MAX_CODE_FILES: '2' }).code, 1);
});

test('wide tier on: six code files with 132 lines pass as wide', () => {
    const r = checkJson(repoWith({}, many(6, 22)), WIDE);
    assert.equal(r.status, 0);
    assert.equal(r.tier, 'wide');
    assert.deepEqual(r.limits, { maxFiles: 5, maxLines: 400, wideMaxFiles: 10, wideMaxLines: 400 });
    assert.equal(checkJson(repoWith({}, many(3, 20)), WIDE).tier, 'normal');
});

test('wide tier on: too many lines or files still fail, with a message naming both tiers', () => {
    const lines450 = checkJson(repoWith({}, many(6, 75)), WIDE);
    assert.equal(lines450.status, 1);
    assert.equal(lines450.tier, null);
    assert.match(lines450.failures.join('\n'), /6 code files, 450 code lines/);
    assert.match(lines450.failures.join('\n'), /up to 5 files and 400 lines, or up to 10 files with at most 400 lines/);
    assert.equal(check(repoWith({}, many(11, 1)), WIDE).code, 1);
    assert.equal(check(repoWith({}, many(10, 40)), WIDE).code, 0, 'ten files at 400 lines pass wide');
});

test('wide line limit can never exceed the normal line limit', () => {
    const big = repoWith({}, many(7, 70));
    assert.equal(check(big, { ...WIDE, MAESTRO_PR_WIDE_MAX_CODE_LINES: '9000' }).code, 1, 'capped at the 400 normal limit');
    assert.equal(check(big, { ...WIDE, MAESTRO_PR_MAX_CODE_LINES: '900', MAESTRO_PR_WIDE_MAX_CODE_LINES: '900' }).code, 0);
    assert.equal(check(repoWith({}, many(7, 50)), { ...WIDE, MAESTRO_PR_MAX_CODE_LINES: '300', MAESTRO_PR_WIDE_MAX_CODE_LINES: '900' }).code, 1, 'wide capped at the lowered normal limit');
    assert.equal(check(repoWith({}, many(7, 40)), { ...WIDE, MAESTRO_PR_WIDE_MAX_CODE_LINES: '250' }).code, 1, 'a lower wide limit applies');
});

test('wide tier on: the printed summary shows the tier, and the wide limits come from the config file', () => {
    const repo = repoWith({}, many(6, 22));
    assert.match(check(repo, WIDE).out, /or up to 10 files under 400 lines; tier wide/);
    const cfg = join(repo, 'cfg.md');
    writeFileSync(cfg, '```maestro-config\npr_wide_max_code_files: 8\n```\n');
    assert.equal(check(repo, { MAESTRO_LOCAL_CONFIG: cfg }).code, 0);
    assert.equal(check(repo, { MAESTRO_LOCAL_CONFIG: cfg, MAESTRO_PR_WIDE_MAX_CODE_FILES: '5' }).code, 1, 'env wins');
});

test('mechanical files plus code still fail in the wide tier', () => {
    const r = checkJson(repoWith({}, (repo) => { many(6, 10)(repo); put(repo, 'uv.lock', lines(10)); }), WIDE);
    assert.equal(r.status, 1);
    assert.deepEqual(r.failures, ['mechanical changes go in their own PR']);
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

test('default classifier: directory names never move a code file out of the code bucket', () => {
    const classify = makeClassifier();
    const bucket = (path: string) => classify({ path, renamed: false, added: 5, deleted: 0 });
    for (const p of [
        'src/docs/render.ts', 'lib/docs/index.ts', 'src/vendor/billing.ts', 'src/test_helpers.py',
        'src/fixtures/loader.ts', 'src/attestation.ts', 'vite.config.ts', 'src/generated/client.ts', 'lib/dist/x.js',
        '.github/scripts/release.py', 'docs/build.py',
    ]) assert.equal(bucket(p), 'code', p);
    // Intended non-code buckets, asserted so they cannot drift.
    assert.equal(bucket('src/prompts/agent.md'), 'docs');
    assert.equal(bucket('docs/guide.md'), 'docs');
    assert.equal(bucket('src/routes.json'), 'config');
    // Anchored mechanical directories, and tests inside test directories.
    assert.equal(bucket('vendor/lib/x.go'), 'mechanical');
    assert.equal(bucket('packages/api/vendor/x.ts'), 'mechanical');
    assert.equal(bucket('dist/app.js'), 'mechanical');
    assert.equal(bucket('tests/test_helpers.py'), 'test');
    assert.equal(bucket('tests/fixtures/loader.ts'), 'test');
    assert.equal(bucket('pkg/foo_test.py'), 'test');
    assert.equal(bucket('src/app.spec.ts'), 'test');
});

test('900 lines in src/docs/render.ts fails the gate end to end', () => {
    const repo = repoWith({}, (r) => put(r, 'src/docs/render.ts', lines(900)));
    const r = checkJson(repo);
    assert.equal(r.status, 1);
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.code.paths, ['src/docs/render.ts']);
    assert.match(r.failures.join('\n'), /900 code lines \(max 400\)/);
});

test('a stale local base with an updated origin base is measured against origin/<base>', () => {
    const repo = repoWith({}, (r) => put(r, 'src/seed.py', lines(1)));
    const remote = mkdtempSync(join(tmpdir(), 'pr-size-remote-'));
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    // origin/main moves ahead by six code files; local main stays stale; feature is cut from the new tip.
    git(repo, 'checkout', '-q', '-b', 'tip', 'main');
    for (let i = 0; i < 6; i++) put(repo, `src/m${i}.py`, lines(1));
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'main moves');
    git(repo, 'push', '-q', 'origin', 'tip:main');
    git(repo, 'checkout', '-q', '-B', 'feature', 'tip');
    put(repo, 'src/mine.py', lines(3));
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'mine');
    const r = checkJson(repo);
    assert.equal(r.status, 0, JSON.stringify(r.failures));
    assert.equal(r.code.files, 1);
    assert.equal(r.code.lines, 3);
});

test('resolveBase falls back to the local ref when there is no origin, and a failed fetch is not fatal', async () => {
    const { resolveBase } = await import('./pr-size.ts');
    const repo = repoWith({}, (r) => put(r, 'src/seed.py', lines(1)));
    assert.equal(resolveBase(repo, 'main'), 'main');
    git(repo, 'remote', 'add', 'origin', join(repo, 'does-not-exist'));
    assert.equal(resolveBase(repo, 'main'), 'main');
});
