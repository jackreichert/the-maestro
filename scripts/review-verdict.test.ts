// Run: node --test scripts/review-verdict.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const { loadVerdicts, recordVerdict, verdictFor, verdictsPath } = await import('./review-verdict.ts');

const SCRIPT = new URL('./review-verdict.ts', import.meta.url).pathname;
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const base = { pr: 'org/repo#7', head: SHA, verdict: 'SHIP IT', reviewer: 'reviewer-a', fixer: 'fixer-b' };
const root = (): string => mkdtempSync(join(tmpdir(), 'verdict-'));

test('a recorded verdict is found for its PR and head commit, by full sha or a 7+ character prefix', () => {
  const r = root();
  recordVerdict(r, base);
  const rows = loadVerdicts(r);
  assert.equal(verdictFor(rows, 'org/repo#7', SHA)?.verdict, 'SHIP IT');
  assert.equal(verdictFor(rows, 'org/repo#7', SHA.slice(0, 7))?.verdict, 'SHIP IT');
  assert.equal(verdictFor(rows, 'org/repo#7', SHA.slice(0, 6)), undefined, 'too short to match');
  assert.equal(verdictFor(rows, 'org/repo#8', SHA), undefined, 'another PR');
  assert.equal(verdictFor(rows, 'org/repo#7', 'f'.repeat(40)), undefined, 'a later head needs a new review');
  assert.equal(verdictFor(rows, 'org/repo#7', undefined), undefined);
});

test('the latest verdict for a head wins, and the spelling is normalized', () => {
  const r = root();
  recordVerdict(r, { ...base, verdict: 'needs-work' });
  assert.equal(verdictFor(loadVerdicts(r), 'org/repo#7', SHA)?.verdict, 'NEEDS WORK');
  recordVerdict(r, { ...base, verdict: 'ship it' });
  assert.equal(verdictFor(loadVerdicts(r), 'org/repo#7', SHA)?.verdict, 'SHIP IT');
});

test('a reviewer who is the fixer is refused and nothing is written', () => {
  const r = root();
  assert.throws(() => recordVerdict(r, { ...base, reviewer: 'Fixer-B' }), /fresh agent must re-review/);
  assert.deepEqual(loadVerdicts(r), []);
});

test('bad input is refused: verdict, pr, sha, missing ids', () => {
  const r = root();
  assert.throws(() => recordVerdict(r, { ...base, verdict: 'LGTM' }), /SHIP IT/);
  assert.throws(() => recordVerdict(r, { ...base, pr: 'repo7' }), /owner\/repo#123/);
  assert.throws(() => recordVerdict(r, { ...base, head: 'main' }), /commit sha/);
  assert.throws(() => recordVerdict(r, { ...base, reviewer: ' ' }), /both required/);
  assert.deepEqual(loadVerdicts(r), []);
});

test('a damaged line is skipped, so damage cannot create a SHIP IT', () => {
  const r = root();
  recordVerdict(r, base);
  appendFileSync(verdictsPath(r), '{not json\n{"pr":1}\n{"pr":"org/repo#7","head":"","verdict":"SHIP IT"}\n');
  assert.equal(loadVerdicts(r).length, 1);
});

test('the CLI records, shows and refuses', () => {
  const r = root();
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a, '--vault', r], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: r, MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(run('show', '--pr', 'org/repo#7').status, 1);
  const ok = run('record', '--pr', 'org/repo#7', '--head', SHA, '--verdict', 'SHIP IT', '--reviewer', 'a', '--fixer', 'b');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /org\/repo#7 abcdef1 SHIP IT/);
  assert.match(run('show', '--pr', 'org/repo#7').stdout, /SHIP IT reviewer=a fixer=b/);
  const self = run('record', '--pr', 'org/repo#7', '--head', SHA, '--verdict', 'SHIP IT', '--reviewer', 'b', '--fixer', 'b');
  assert.equal(self.status, 1);
  assert.match(self.stderr, /fresh agent/);
  assert.equal(run('bogus').status, 2);
});
