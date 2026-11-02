import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureSource } from './lib/quality-ratchet/measure.ts';
import { inScope } from './lib/quality-ratchet/scan.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'lib/quality-ratchet/fixtures');
const CLI = join(HERE, 'quality-ratchet.ts');

function repoWith(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(FIX, `${fixture}.ts`), join(root, 'scripts/target.ts'));
  return root;
}

function swap(root: string, fixture: string, name = 'target'): void {
  copyFileSync(join(FIX, `${fixture}.ts`), join(root, `scripts/${name}.ts`));
}

function run(root: string, ...args: string[]) {
  const r = spawnSync('node', [CLI, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('measure: counts lines, function length and complexity', () => {
  const m = measureSource('export function f(a: number) {\n  if (a && a > 1) return 1;\n  for (const x of [1]) { void x; }\n  return a ? 2 : 3;\n}\n');
  assert.deepEqual(m, { lines: 5, longestFunction: 5, maxComplexity: 5, overThreshold: 0 });
});

test('measure: nested functions count separately', () => {
  const m = measureSource('function a() {\n  const b = () => {\n    if (1) return 1;\n    return 2;\n  };\n  return b();\n}\n');
  assert.equal(m.maxComplexity, 2);
  assert.equal(m.longestFunction, 7);
});

test('scope: tests, cases, fixtures and declarations are excluded', () => {
  assert.equal(inScope('scripts/a.ts'), true);
  assert.equal(inScope('scripts/a.test.ts'), false);
  assert.equal(inScope('scripts/a.cases.ts'), false);
  assert.equal(inScope('scripts/lib/x/fixtures/a.ts'), false);
  assert.equal(inScope('scripts/lib/a-fixture.ts'), false);
  assert.equal(inScope('scripts/a.d.ts'), false);
});

test('same: unchanged debt passes', () => {
  const root = repoWith('same');
  assert.equal(run(root, 'update').code, 0);
  const r = run(root, 'check');
  assert.equal(r.code, 0, r.out);
});

test('worse: a regression fails and names file, metric, baseline and now', () => {
  const root = repoWith('same');
  run(root, 'update');
  swap(root, 'worse');
  const r = run(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.out, /scripts\/target\.ts\s+longestFunction\s+baseline 72\s+now 94/);
  assert.match(r.out, /scripts\/target\.ts\s+lines\s+baseline 72\s+now 94/);
});

test('better: improvement passes and tells you to lower the baseline', () => {
  const root = repoWith('same');
  run(root, 'update');
  swap(root, 'better');
  const r = run(root, 'check');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /better: scripts\/target\.ts\s+longestFunction/);
  assert.match(r.out, /ratchet:update/);
  assert.equal(run(root, 'update').code, 0);
  assert.match(readFileSync(join(root, 'quality-baseline.json'), 'utf8'), /"longestFunction":66/);
});

test('new file: must meet the limits outright', () => {
  const root = repoWith('same');
  run(root, 'update');
  swap(root, 'new-clean', 'fresh');
  assert.equal(run(root, 'check').code, 0);
  swap(root, 'new-bad', 'fresh');
  const r = run(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.out, /scripts\/fresh\.ts\s+maxComplexity\s+new file limit exceeded\s+now 17/);
});

test('update: refuses to loosen without a reason, records it with one', () => {
  const root = repoWith('same');
  run(root, 'update');
  swap(root, 'worse');
  const refused = run(root, 'update');
  assert.equal(refused.code, 1);
  assert.match(refused.out, /refused/);
  assert.equal(run(root, 'update', '--allow-loosen').code, 2);
  assert.equal(run(root, 'update', '--allow-loosen', '--reason', 'split lands next PR').code, 0);
  const text = readFileSync(join(root, 'quality-baseline.json'), 'utf8');
  assert.match(text, /split lands next PR/);
  assert.equal(run(root, 'check').code, 0);
});

test('update: a file that now meets the limits leaves the baseline', () => {
  const root = repoWith('same');
  run(root, 'update');
  writeFileSync(join(root, 'scripts/target.ts'), 'export const x = 1;\n');
  run(root, 'update');
  assert.doesNotMatch(readFileSync(join(root, 'quality-baseline.json'), 'utf8'), /target\.ts/);
});
