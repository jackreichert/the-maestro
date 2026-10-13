// Run: node --test scripts/suite-summary.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselinePath, parseCli, runnerCommand } from './suite-summary.ts';
import { readBaseline } from './lib/suite-metrics.ts';

const SCRIPT = new URL('./suite-summary.ts', import.meta.url).pathname;
const GREEN = "import { test } from 'node:test';\ntest('quick', () => {});\ntest('sleepy', async () => { await new Promise((r) => setTimeout(r, 300)); });\n";
const RED = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('quick', () => {});\ntest('broken', () => { assert.equal(1, 2); });\n";

/** A throwaway git repo holding one test file, plus the suites dir that holds its baseline. */
function fixture(testSource: string): { repo: string; suites: string } {
  const root = mkdtempSync(join(tmpdir(), 'suite-summary-test-'));
  const repo = join(root, 'demo-repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'a.test.ts'), testSource);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['config', 'core.hooksPath', '/dev/null'], ['config', 'commit.gpgsign', 'false'],['add', 'a.test.ts'], ['commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).status, 0);
  }
  return { repo, suites: join(root, 'suites') };
}

const summary = (f: { repo: string; suites: string }, ...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  return spawnSync(process.execPath, [SCRIPT, '--repo', f.repo, '--tests', 'a.test.ts', ...args], { encoding: 'utf8', env: { ...env, MAESTRO_SUITE_DIR: f.suites } });
};

test('a green run exits 0, writes a baseline on request, and a second run compares against it', () => {
  const f = fixture(GREEN);
  const first = summary(f, '--write-baseline', '--json');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const out = JSON.parse(first.stdout) as { ok: boolean; summary: { counts: { pass: number }; regressions: unknown; slowest: { id: string }[] }; baseline: { written: boolean } };
  assert.equal(out.summary.counts.pass, 2);
  assert.equal(out.summary.regressions, null);
  assert.equal(out.baseline.written, true);
  assert.equal(out.summary.slowest[0]?.id, 'a.test.ts > sleepy');
  const stored = readBaseline(baselinePath(f.repo, 'node', undefined, { MAESTRO_SUITE_DIR: f.suites }));
  assert.deepEqual(Object.keys(stored?.tests ?? {}).sort(), ['a.test.ts > quick', 'a.test.ts > sleepy']);
  const second = summary(f);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /PASS/);
  assert.match(second.stdout, /regressions vs baseline .*: none/);
});

test('a failing run exits 1, names the test and its error, and refuses to write a baseline', () => {
  const f = fixture(RED);
  const r = summary(f, '--write-baseline');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL a\.test\.ts > broken\n\s+Expected values to be strictly equal/);
  assert.match(r.stdout, /not written: the run is not green/);
  assert.equal(readBaseline(baselinePath(f.repo, 'node', undefined, { MAESTRO_SUITE_DIR: f.suites })), null);
});

test('a runner that produces no report, or matches no tests, exits 2 rather than passing', () => {
  const f = fixture(GREEN);
  assert.equal(summary(f, '--cmd', 'exit 0').status, 2);
  const none = spawnSync(process.execPath, [SCRIPT, '--repo', f.repo, '--tests', 'nothing-here.test.ts'], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(none.status, 2, none.stdout);
  assert.match(none.stdout, /RUNNER ERROR/);
});

test('a runner binary that is not installed exits 2, not a crash', () => {
  const f = fixture(GREEN);
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env;
  const missing = spawnSync(process.execPath, [SCRIPT, '--repo', f.repo, '--runner', 'jest'], { encoding: 'utf8', env: { ...env, PATH: '/usr/bin:/bin' } });
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /RUNNER ERROR/);
});

test('bad flags exit 2 with a usage message', () => {
  const f = fixture(GREEN);
  assert.equal(summary(f, '--runner', 'mocha').status, 2);
  assert.equal(summary(f, '--top', '0').status, 2);
  assert.equal(summary(f, '--gates').status, 2);
});

test('parseCli and runnerCommand: defaults, jest and pytest commands, and --cmd with {out}', () => {
  assert.equal(parseCli(['--repo', tmpdir()]).options.factor, 2);
  assert.deepEqual(runnerCommand('jest', '/o', {}), ['npx', ['jest', '--json', '--outputFile=/o']]);
  assert.deepEqual(runnerCommand('pytest', '/o', {})[1].slice(-1), ['--junitxml=/o']);
  assert.deepEqual(runnerCommand('node', '/o', { cmd: 'make test OUT={out}' }), ['/bin/sh', ['-c', 'make test OUT=/o']]);
  assert.ok(runnerCommand('node', '/o', { concurrency: 3 })[1].includes('--test-concurrency=3'));
});
