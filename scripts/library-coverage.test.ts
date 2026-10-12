// Run: node --test scripts/library-coverage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COVERS, REQUIRED_PAGES } from './lib/library/coverage.ts';
import { parseOptions } from './library-check.ts';

const SCRIPT = new URL('./library-check.ts', import.meta.url).pathname;
const page = (repo: string, covers: string, status = 'current'): string => `---\ntype: library\nkind: runbook\nrepo: ${repo}\nstream: S\ncomponents: [core]\nstatus: ${status}\nverified-at: 2026-10-08\nverify-how: "read x"\ncomposed-by: composer\n${covers ? `covers: ${covers}\n` : ''}---\n# P\n\nRead when: testing.\n\n## Facts\n\n- A fact (verified 2026-10-08, x).\n`;
function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'coverage-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--coverage', '--vault', root, ...args], { encoding: 'utf8' });

const FILES = {
  'Projects/alpha/Runbooks/a.md': page('alpha', '[setup, run-local]'),
  'Projects/alpha/Knowledge/b.md': page('alpha', '[how-it-works]'),
  'Projects/alpha/Knowledge/old.md': page('alpha', '[deploy]', 'superseded'),
  'Projects/beta/Knowledge/c.md': page('beta', ''),
  'Projects/gamma/CONTEXT.md': 'no library here',
};

test('the required list is the six documented kinds, once', () => {
  assert.deepEqual(COVERS, ['setup', 'run-local', 'test-staging', 'verify-prod', 'deploy', 'how-it-works']);
  assert.equal(new Set(COVERS).size, REQUIRED_PAGES.length);
});

test('--json lists missing kinds per project with a library, ignoring superseded pages, and lists a library-less project as missing all six', () => {
  const r = run(vault(FILES), '--json');
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map((x: { repo: string }) => x.repo), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(rows[0].missing, ['test-staging', 'verify-prod', 'deploy']);
  assert.deepEqual(rows[0].covered['setup'], ['Projects/alpha/Runbooks/a.md']);
  assert.equal(rows[0].pages, 2);
  assert.deepEqual(rows[1].missing, COVERS);
  assert.deepEqual(rows[2], { repo: 'gamma', pages: 0, covered: {}, missing: COVERS });
});

test('a project with no pages shows as missing 6/6 in text, and stray folders without CONTEXT.md or INDEX.md are skipped', () => {
  const r = run(vault({ ...FILES, 'Projects/stray/notes.md': 'x', 'Projects/delta/INDEX.md': 'i' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gamma {2}missing 6\/6: Setup from scratch/);
  assert.match(r.stdout, /delta {2}missing 6\/6/);
  assert.doesNotMatch(r.stdout, /stray/);
  assert.match(r.stdout, /4 projects, 4 with missing pages/);
});

test('--repo naming an existing project with no pages returns its row, exit 0', () => {
  const root = vault(FILES);
  const r = run(root, '--repo', 'gamma', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ repo: 'gamma', pages: 0, covered: {}, missing: COVERS }]);
  assert.match(run(root, '--repo', 'gamma').stdout, /gamma {2}missing 6\/6/);
});

test('text output names the missing pages and --repo narrows it', () => {
  const r = run(vault(FILES), '--repo', 'alpha');
  assert.match(r.stdout, /alpha {2}missing 3\/6: Test in staging; Verify in prod \(read-only checks\); Deploy path/);
  assert.match(r.stdout, /1 project, 1 with missing pages/);
  assert.doesNotMatch(r.stdout, /beta/);
});

test('a project that covers everything reports complete', () => {
  const all = Object.fromEntries(COVERS.map((c) => [`Projects/full/Knowledge/${c}.md`, page('full', `[${c}]`)]));
  assert.match(run(vault(all)).stdout, /full {2}complete/);
});

test('usage errors exit 2', () => {
  assert.equal(run(vault({ 'Projects/x/CONTEXT.md': 'n' }), '--repo', 'nope').status, 2);
  assert.equal(run(vault({ 'Projects/x/CONTEXT.md': 'n' })).status, 0);
  assert.equal(typeof parseOptions(['--coverage', '--stale']), 'string');
  assert.equal(typeof parseOptions(['--coverage', 'page.md']), 'string');
  assert.equal(run(vault(FILES), '--repo', '../x').status, 2);
});
