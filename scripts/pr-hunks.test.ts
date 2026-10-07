// Run: node --test scripts/pr-hunks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedRanges, hunkTokens } from './pr-hunks.ts';

const LINKS = new URL('./pr-guide-links.ts', import.meta.url).pathname;

/** A three-line-context diff: alpha has two hunks, beta is new, gone is deleted, café is quoted by git, rename moves a file. */
const DIFF = [
  'diff --git a/src/widgets/alpha.ts b/src/widgets/alpha.ts',
  'index 111..222 100644',
  '--- a/src/widgets/alpha.ts',
  '+++ b/src/widgets/alpha.ts',
  '@@ -10,7 +10,9 @@ export function a() {',
  ' ctx10',
  ' ctx11',
  ' ctx12',
  '-old13',
  '+new13',
  '+new14',
  '+new15',
  ' ctx16',
  ' ctx17',
  ' ctx18',
  '@@ -40,3 +42,4 @@',
  ' ctx42',
  '+new43',
  ' ctx44',
  ' ctx45',
  'diff --git a/src/widgets/beta.ts b/src/widgets/beta.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/widgets/beta.ts',
  '@@ -0,0 +1,3 @@',
  '+one',
  '+two',
  '+three',
  'diff --git a/src/widgets/gone.ts b/src/widgets/gone.ts',
  'deleted file mode 100644',
  '--- a/src/widgets/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
  'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
  '--- "a/src/caf\\303\\251.ts"',
  '+++ "b/src/caf\\303\\251.ts"',
  '@@ -5 +5 @@',
  '-before',
  '+after',
  '\\ No newline at end of file',
  'diff --git a/src/widgets/old.ts b/src/widgets/new.ts',
  'similarity index 90%',
  'rename from src/widgets/old.ts',
  'rename to src/widgets/new.ts',
  '--- a/src/widgets/old.ts',
  '+++ b/src/widgets/new.ts',
  '@@ -3,1 +3,2 @@',
  ' keep',
  '+added',
  '',
].join('\n');

test('changedRanges lists runs of added lines per new-side path; context never widens a range', () => {
  const r = changedRanges(DIFF);
  assert.deepEqual(r.get('src/widgets/alpha.ts'), [{ start: 13, end: 15 }, { start: 43, end: 43 }]);
  assert.deepEqual(r.get('src/widgets/beta.ts'), [{ start: 1, end: 3 }]);
  assert.deepEqual(r.get('src/café.ts'), [{ start: 5, end: 5 }]);
  assert.deepEqual(r.get('src/widgets/new.ts'), [{ start: 4, end: 4 }]);
  assert.ok(!r.has('src/widgets/gone.ts'), 'a pure deletion has no new-side line');
});

test('changedRanges reads a git diff -U0 the same way', () => {
  const u0 = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -5,0 +6,2 @@', '+x', '+y', '@@ -9,2 +12,0 @@', '-p', '-q', '@@ -20 +21 @@', '-m', '+n', ''].join('\n');
  assert.deepEqual(changedRanges(u0).get('a.ts'), [{ start: 6, end: 7 }, { start: 21, end: 21 }]);
});

test('a line starting with +++ inside a hunk is added text, not a file header', () => {
  const d = ['diff --git a/n.md b/n.md', '--- a/n.md', '+++ b/n.md', '@@ -1 +1,2 @@', ' keep', '+++ not a header', ''].join('\n');
  assert.deepEqual(changedRanges(d).get('n.md'), [{ start: 2, end: 2 }]);
});

test('hunkTokens emits pasteable tokens and can be limited to one path', () => {
  const r = changedRanges(DIFF);
  assert.deepEqual(hunkTokens(r, 'src/widgets/alpha.ts'), ['{{file:src/widgets/alpha.ts#R13-R15}}', '{{file:src/widgets/alpha.ts#R43}}']);
  assert.equal(hunkTokens(r).length, 5);
});

test('pr-guide-links --hunks prints the tokens from gh pr diff, writes nothing, and fails on an unknown path or bad usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-hunks-'));
  const diffFile = join(dir, 'd.diff');
  const log = join(dir, 'gh.log');
  writeFileSync(diffFile, DIFF);
  const gh = join(dir, 'gh.sh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1 $2" = "pr diff" ] && cat '${diffFile}'\n`);
  chmodSync(gh, 0o755);
  const env = { PATH: process.env.PATH, MAESTRO_GH_BIN: gh };
  const run = (...a: string[]) => spawnSync(process.execPath, [LINKS, ...a], { encoding: 'utf8', env });
  const ok = run('--hunks', dir, '7', 'src/widgets/beta.ts');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '{{file:src/widgets/beta.ts#R1-R3}}\n');
  assert.equal(run('--hunks', dir, '7').stdout.trim().split('\n').length, 5);
  assert.equal(run('--hunks', dir, '7', 'src/nope.ts').status, 1);
  assert.equal(run('--hunks', dir).status, 2);
  assert.equal(run(dir, '7', 'extra').status, 2);
  assert.ok(!/pr (edit|view)/.test(readFileSync(log, "utf8")), 'only pr diff is called');
});

