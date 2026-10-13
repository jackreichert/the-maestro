// Run: node --test scripts/cache-lint.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintDoc, lintRepo } from './cache-lint.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const GOOD = '- Suites: run `suite-run.ts` detached, idle under 4 minutes, reviewers run targeted tests plus tsc only.';

test('this repo passes its own cache lint', () => {
  assert.deepEqual(lintRepo(ROOT), []);
});

test('the brief fails when the Suites line is missing or loses a needle', () => {
  assert.deepEqual(lintDoc('brief.md', GOOD, 'brief'), []);
  assert.equal(lintDoc('brief.md', '- Waits: foreground.', 'brief')[0]?.rule, 'suites-line');
  const f = lintDoc('brief.md', GOOD.replace('4 minutes', '10 minutes'), 'brief');
  assert.match(f[0]!.text, /4 minutes/);
});

test('sleeps over 270 seconds are flagged, 270 and shorter pass, units are read', () => {
  assert.deepEqual(lintDoc('a.md', 'run `sleep 270`', 'other'), []);
  assert.equal(lintDoc('a.md', 'then `sleep 300` again', 'other')[0]?.rule, 'long-sleep');
  assert.equal(lintDoc('a.md', 'until x; do sleep 5m; done', 'other').length, 1);
  assert.deepEqual(lintDoc('a.md', 'sleep 4m', 'other'), []);
});

test('a full suite in a playbook code block is flagged; a targeted run and prose are not', () => {
  const doc = (cmd: string) => `text\n\`\`\`bash\n${cmd}\n\`\`\`\n`;
  assert.equal(lintDoc('p.md', doc('npm test'), 'playbook')[0]?.rule, 'foreground-suite');
  assert.equal(lintDoc('p.md', doc('node --test'), 'playbook').length, 1);
  assert.deepEqual(lintDoc('p.md', doc('node --test scripts/one.test.ts'), 'playbook'), []);
  assert.deepEqual(lintDoc('p.md', 'run npm test yourself', 'playbook'), []);
  assert.deepEqual(lintDoc('r.md', doc('npm test'), 'other'), []);
});

test('the CLI exits 1 with file:line on a bad tree and 0 on a clean one', () => {
  const root = mkdtempSync(join(tmpdir(), 'cache-lint-'));
  mkdirSync(join(root, 'reference'));
  mkdirSync(join(root, 'playbooks'));
  writeFileSync(join(root, 'reference', 'brief.md'), `${GOOD}\n`);
  writeFileSync(join(root, 'playbooks', 'x.md'), '```bash\nsleep 600\n```\n');
  const bad = spawnSync('node', [join(ROOT, 'scripts', 'cache-lint.ts'), '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /playbooks\/x\.md:2 \[long-sleep\]/);
  writeFileSync(join(root, 'playbooks', 'x.md'), 'fine\n');
  const ok = spawnSync('node', [join(ROOT, 'scripts', 'cache-lint.ts'), '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
});
