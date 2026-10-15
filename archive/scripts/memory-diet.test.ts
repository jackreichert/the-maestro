// Run: node --test scripts/memory-diet.test.ts
// Fixture strings only. The live skill file and any memory index are never opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./memory-diet.ts', import.meta.url));
const PASS = 'cold-start check passed\n';
const FAIL = 'cold-start check: FAILED (1 missing, 0 problems)\n';

const FIXTURE = `## Hard limits
Look this up later with find. It reads like a command index.

## Command index
Open the matching page with library-brief when the task needs a command.
`;

const TOKEN = `ghp_${'a'.repeat(36)}`;

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-diet-'));
}

function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' },
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

function between(text: string, start: string, end: string): string {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `missing ${start} in:\n${text}`);
  const rest = text.slice(at + start.length);
  const next = rest.indexOf(end);
  return next === -1 ? rest : rest.slice(0, next);
}

test('a missing comparison refuses a shrink and changes nothing', () => {
  const root = dir();
  const fixture = join(root, 'fixture.md');
  const canary = join(root, 'canary.txt');
  writeFileSync(fixture, FIXTURE);
  writeFileSync(canary, 'keep\n');
  const omitted = run(root, ['--fixture', fixture]);
  assert.equal(omitted.status, 1);
  assert.equal(omitted.stdout, '');
  assert.match(omitted.stderr, /refusing shrink/);
  assert.match(omitted.stderr, /comparison is required/);
  assert.match(omitted.stderr, /deleted: none/);
  assert.doesNotMatch(`${omitted.stdout}${omitted.stderr}`, /movable behind find or library-brief/);
  assert.doesNotMatch(`${omitted.stdout}${omitted.stderr}`, /Command index/);

  const missing = run(root, ['--fixture', fixture, '--comparison', join(root, 'no-such-artifact.txt')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /comparison artifact is missing/);
  assert.match(missing.stderr, /shrink recommendation: refused/);
  assert.equal(readFileSync(fixture, 'utf8'), FIXTURE);
  assert.equal(readFileSync(canary, 'utf8'), 'keep\n');
  assert.deepEqual(readdirSync(root).sort(), ['canary.txt', 'fixture.md']);
});

test('a failing comparison refuses a shrink and changes nothing', () => {
  const root = dir();
  const fixture = join(root, 'fixture.md');
  const comparison = join(root, 'comparison.txt');
  writeFileSync(fixture, FIXTURE);
  writeFileSync(comparison, FAIL);
  const failed = run(root, ['--fixture', fixture, '--comparison', comparison]);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /refusing shrink/);
  assert.match(failed.stderr, /cold-start check failed/);
  assert.match(failed.stderr, /deleted: none/);
  assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /movable behind find or library-brief/);
  assert.equal(readFileSync(fixture, 'utf8'), FIXTURE);
  assert.equal(readFileSync(comparison, 'utf8'), FAIL);

  writeFileSync(comparison, 'cold-start check passed\ncold-start check: FAILED (1 missing, 0 problems)\n');
  const mixed = run(root, ['--fixture', fixture, '--comparison', comparison]);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /cold-start check failed/);
  assert.doesNotMatch(mixed.stdout, /Command index/);
  assert.equal(readFileSync(fixture, 'utf8'), FIXTURE);
});

test('a passing comparison lists movable sections and still deletes nothing', () => {
  const root = dir();
  const fixture = join(root, 'fixture.md');
  const comparison = join(root, 'comparison.txt');
  const canary = join(root, 'canary.txt');
  writeFileSync(fixture, FIXTURE);
  writeFileSync(comparison, PASS);
  writeFileSync(canary, 'keep\n');
  const out = run(root, ['--fixture', fixture, '--comparison', comparison]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /shrink recommendation: list only; not applied/);
  const movable = between(out.stdout, 'movable behind find or library-brief:', 'must stay:');
  assert.match(movable, /Command index/);
  assert.match(out.stdout, /deleted: none/);
  assert.match(out.stdout, /changed: none/);
  assert.equal(readFileSync(fixture, 'utf8'), FIXTURE);
  assert.equal(readFileSync(comparison, 'utf8'), PASS);
  assert.equal(readFileSync(canary, 'utf8'), 'keep\n');
  assert.deepEqual(readdirSync(root).sort(), ['canary.txt', 'comparison.txt', 'fixture.md']);
  const source = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|renameSync|truncateSync|copyFile|copyFileSync|mkdirSync|createWriteStream)\b/);
});

test('a hard-limit heading is never listed as movable', () => {
  const root = dir();
  const fixture = join(root, 'fixture.md');
  const comparison = join(root, 'comparison.txt');
  const text = `## Hard limits
This section could be looked up with find or library-brief. Treat it as a command index anyway.

## Lookup table
Steps for a rare task. Open them with library-brief when needed.
`;
  writeFileSync(fixture, text);
  writeFileSync(comparison, 'cold-start check: passed\n');
  const out = run(root, ['--fixture', fixture, '--comparison', comparison]);
  assert.equal(out.status, 0, out.stderr);
  const movable = between(out.stdout, 'movable behind find or library-brief:', 'must stay:');
  const stay = between(out.stdout, 'must stay:', 'deleted: none');
  assert.match(movable, /Lookup table/);
  assert.doesNotMatch(movable, /Hard limits/);
  assert.match(stay, /Hard limits/);
  assert.equal(readFileSync(fixture, 'utf8'), text);
  assert.doesNotMatch(`${out.stdout}${out.stderr}`, new RegExp(TOKEN));
});

test('secret-shaped fixture text is not printed', () => {
  const root = dir();
  const fixture = join(root, 'fixture.md');
  const comparison = join(root, 'comparison.txt');
  writeFileSync(fixture, `## Command index\nToken ${TOKEN} stays in the fixture and must not be printed.\n`);
  writeFileSync(comparison, PASS);
  const out = run(root, ['--fixture', fixture, '--comparison', comparison]);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(`${out.stdout}${out.stderr}`, /ghp_/);
  assert.equal(readFileSync(fixture, 'utf8').includes(TOKEN), true);
});
