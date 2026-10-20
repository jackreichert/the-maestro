// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/others-list.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './others-list.ts';
import { listPath, readList } from './lib/teammate/others-list.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'others-cli-'));
const o = (statusDir: string) => ({ statusDir, owners: ['Acme-Fake'], now: 1000 });

test('add puts a PR on the list by key or URL, once, as a manual add', () => {
  const d = dir();
  assert.deepEqual(run(['add', 'acme-fake/widgets#7'], o(d)), { code: 0, out: 'Added acme-fake/widgets#7. It shows on the tab at the next refresh.' });
  assert.match(run(['add', 'https://github.com/Acme-Fake/widgets/pull/7'], o(d)).out, /already on the list/);
  assert.deepEqual([...readList(listPath(d)).active.values()].map((e) => [e.key, e.source, e.at]), [['acme-fake/widgets#7', 'manual', 1000]]);
});

test('add refuses a PR outside the review owners, and anything that is not a PR', () => {
  const d = dir();
  assert.equal(run(['add', 'other-fake/x#1'], o(d)).code, 1);
  assert.equal(run(['add', 'nonsense'], o(d)).code, 2);
  assert.equal(run(['add'], o(d)).code, 2);
  assert.equal(readList(listPath(d)).active.size, 0);
});

test('drop takes a PR off and a later add puts it back', () => {
  const d = dir();
  run(['add', 'acme-fake/widgets#7'], o(d));
  assert.equal(run(['drop', 'acme-fake/widgets#7'], o(d)).out, 'Dropped acme-fake/widgets#7.');
  assert.match(run(['drop', 'acme-fake/widgets#7'], o(d)).out, /was not on the list/);
  assert.match(run(['add', 'acme-fake/widgets#7'], o(d)).out, /had been dropped/);
  assert.equal(readList(listPath(d)).active.size, 1);
});

test('list shows how each PR joined, and as JSON for scripts', () => {
  const d = dir();
  run(['add', 'acme-fake/widgets#7'], o(d));
  assert.equal(run(['list'], o(d)).out, 'acme-fake/widgets#7  manual');
  assert.equal((JSON.parse(run(['list', '--json'], o(d)).out) as { active: unknown[] }).active.length, 1);
  assert.equal(run(['list'], o(dir())).out, 'The list is empty.');
});

test('with no status directory it says so and writes nothing; an unknown command prints usage', () => {
  assert.equal(run(['add', 'acme-fake/widgets#7'], { statusDir: '', owners: ['acme-fake'] }).code, 2);
  assert.match(run(['frobnicate'], o(dir())).out, /^Usage:/);
});
