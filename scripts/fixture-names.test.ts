// Run: node --test scripts/fixture-names.test.ts
// Stub pattern list only. No network, and the real hooks pattern file is never opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestOrFixture } from './fixture-names.ts';

const SCRIPT = fileURLToPath(new URL('./fixture-names.ts', import.meta.url));
const TOKEN = 'acme/widget';
const PLACEHOLDER = 'example-org/example-repo';

const git = (repo: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'fixture-names-'));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 'test@example.com');
  git(r, 'config', 'user.name', 'Test');
  git(r, 'config', 'core.hooksPath', '/dev/null');
  return r;
}

function stage(r: string, path: string, text: string): void {
  const abs = join(r, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
  git(r, 'add', '--', path);
}

function patterns(dir: string, text: string): string {
  const file = join(dir, 'names.txt');
  writeFileSync(file, text);
  return file;
}

function run(r: string, file: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const childEnv = { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_PRIVATE_PATTERNS: file, ...env };
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', r, '--patterns', file, ...extra], { encoding: 'utf8', env: childEnv });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test('a test or fixture path is in scope; a source file and this script are not', () => {
  assert.equal(isTestOrFixture('scripts/sample.test.ts'), true);
  assert.equal(isTestOrFixture('pkg/widget_test.py'), true);
  assert.equal(isTestOrFixture('scripts/journal.cases.ts'), true);
  assert.equal(isTestOrFixture('fixtures/sample.json'), true);
  assert.equal(isTestOrFixture('src/app.ts'), false);
  assert.equal(isTestOrFixture('scripts/fixture-names.ts'), false);
});

test('a staged test that adds the configured token is refused, without printing the token', () => {
  const r = repo();
  const file = patterns(r, `${TOKEN}\n`);
  stage(r, 'tests/sample.test.ts', `const repo = '${TOKEN}';\n`);
  const out = run(r, file);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /tests\/sample\.test\.ts: private-name/);
  assert.equal(out.stdout, '');
  assert.doesNotMatch(`${out.stdout}${out.stderr}`, /acme|widget/);
});

test('a fictional placeholder that is not the configured token passes, including in a fixture file', () => {
  const r = repo();
  const file = patterns(r, `${TOKEN}\n`);
  stage(r, 'fixtures/sample.json', `{"repo":"${PLACEHOLDER}"}\n`);
  stage(r, 'src/app.ts', `const repo = '${TOKEN}';\n`);
  const out = run(r, file);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
});

test('acme/widget passes when it is not on the configured list', () => {
  const r = repo();
  const file = patterns(r, `${PLACEHOLDER}\n`);
  stage(r, 'tests/sample.test.ts', `const repo = '${TOKEN}';\n`);
  const out = run(r, file);
  assert.equal(out.status, 0, out.stderr);
});

test('the match is case-insensitive, same as the push grep, and only added lines count', () => {
  const r = repo();
  const file = patterns(r, `${TOKEN}\n`);
  stage(r, 'tests/sample.test.ts', `const repo = '${PLACEHOLDER}';\n`);
  git(r, 'commit', '-q', '-m', 'test: fixture');
  stage(r, 'tests/sample.test.ts', `const repo = '${PLACEHOLDER}';\nconst again = '${TOKEN.toUpperCase()}';\n`);
  const bad = run(r, file);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /private-name/);
  assert.doesNotMatch(bad.stderr, /ACME|acme/);

  stage(r, 'tests/sample.test.ts', `const repo = '${PLACEHOLDER}';\nconst note = 'unchanged token stays';\n`);
  const ok = run(r, file);
  assert.equal(ok.status, 0, ok.stderr);
});

test('a blank line in the list does not match every fixture', () => {
  const r = repo();
  const file = patterns(r, `${TOKEN}\n\n`);
  stage(r, 'tests/sample.test.ts', `const repo = '${PLACEHOLDER}';\n`);
  const out = run(r, file);
  assert.equal(out.status, 0, out.stderr);
});

test('a missing, empty, unreadable or unusable list fails closed and prints no name', () => {
  const r = repo();
  stage(r, 'tests/sample.test.ts', `const repo = '${PLACEHOLDER}';\n`);
  const missing = run(r, join(r, 'no-such-list.txt'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /configured name list cannot be read/);
  assert.doesNotMatch(missing.stderr, /acme|widget|example-org/);

  const empty = patterns(r, '\n');
  const blank = run(r, empty);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /configured name list cannot be read/);

  const dir = join(r, 'not-a-file');
  mkdirSync(dir);
  const asDir = run(r, dir);
  assert.equal(asDir.status, 1);
  assert.match(asDir.stderr, /configured name list cannot be read/);

  const locked = patterns(r, `${TOKEN}\n`);
  chmodSync(locked, 0);
  const denied = run(r, locked);
  chmodSync(locked, 0o644);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /configured name list cannot be read/);
  assert.doesNotMatch(denied.stderr, /acme/);

  const broken = patterns(r, '(unclosed\n');
  const bad = run(r, broken);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot be applied/);
  assert.doesNotMatch(bad.stderr, /unclosed/);
});

test('with no --patterns flag the list is the hooks private-patterns file', () => {
  const r = repo();
  const hooks = join(r, 'hookdir');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'private-patterns.txt'), `${TOKEN}\n`);
  git(r, 'config', 'core.hooksPath', hooks);
  stage(r, 'tests/sample.test.ts', `const repo = '${TOKEN}';\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, MAESTRO_LOCAL_CONFIG: '' };
  delete env.MAESTRO_PRIVATE_PATTERNS;
  const out = spawnSync(process.execPath, [SCRIPT, '--repo', r], { encoding: 'utf8', env });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /tests\/sample\.test\.ts: private-name/);
  assert.doesNotMatch(`${out.stdout}${out.stderr}`, /acme|widget/);
});

test('unknown usage exits 2 and does not scan', () => {
  const out = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /unknown argument/);
});
