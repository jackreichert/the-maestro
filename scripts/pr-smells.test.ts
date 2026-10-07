// Run: node --test scripts/pr-smells.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateApplies, headSha, recordFor, recordSmells, repoSlug, smellsLine, smellsProblems } from './pr-smells.ts';

const SCRIPT = new URL('./pr-smells.ts', import.meta.url).pathname;
const git = (repo: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A repo with one commit and, when given, an origin remote. */
function repo(remote = 'https://github.com/example/widgets.git'): string {
  const r = mkdtempSync(join(tmpdir(), 'smells-'));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 'test@example.com');
  git(r, 'config', 'user.name', 'Test');
  git(r, 'config', 'core.hooksPath', '/dev/null');
  if (remote) git(r, 'remote', 'add', 'origin', remote);
  commit(r, 'a');
  return r;
}
const commit = (r: string, name: string): void => { writeFileSync(join(r, name), `${name}\n`); git(r, 'add', name); git(r, 'commit', '-q', '-m', name); };

test('repoSlug reads https and ssh GitHub remotes and nothing else', () => {
  assert.equal(repoSlug('https://github.com/example/widgets.git'), 'example/widgets');
  assert.equal(repoSlug('git@github.com:example/widgets.git'), 'example/widgets');
  assert.equal(repoSlug('https://github.com/example/widgets'), 'example/widgets');
  assert.equal(repoSlug('https://gitlab.com/example/widgets.git'), '');
  assert.equal(repoSlug(''), '');
});

test('the gate applies only to repos matching a glob, and never with an empty list', () => {
  const r = repo();
  assert.equal(gateApplies(r, []), false);
  assert.equal(gateApplies(r, ['example/*']), true);
  assert.equal(gateApplies(r, ['Example/Widgets']), true);
  assert.equal(gateApplies(r, ['other/*']), false);
  assert.equal(gateApplies(repo(''), ['*/*']), false, 'no origin, no gate');
});

test('a record names the head commit and a later commit invalidates it', () => {
  const r = repo();
  assert.equal(recordFor(r), undefined);
  const rec = recordSmells(r, '  two\nfindings, one fixed  ');
  assert.equal(rec.head, headSha(r));
  assert.equal(rec.summary, 'two findings, one fixed');
  assert.equal(recordFor(r)?.summary, 'two findings, one fixed');
  commit(r, 'b');
  assert.equal(recordFor(r), undefined, 'new head, run must be repeated');
});

test('an empty summary is refused and nothing is written', () => {
  const r = repo();
  assert.throws(() => recordSmells(r, '   '), /--summary is required/);
  assert.equal(recordFor(r), undefined);
});

test('smellsProblems: refuses without a record, then without the body line, then passes', () => {
  const r = repo();
  const globs = ['example/*'];
  assert.match(smellsProblems(r, '', 'body', 3, globs)[0], /no smells run is recorded/);
  const rec = recordSmells(r, 'none found');
  assert.match(smellsProblems(r, '', 'body', 3, globs)[0], /Smells: none found/);
  assert.match(smellsProblems(r, '', 'Smells: something else', 3, globs)[0], /on a line of its own/);
  assert.deepEqual(smellsProblems(r, '', `intro\n${smellsLine(rec)}\n`, 3, globs), []);
});

test('smellsProblems: a docs-only diff and a repo outside the gate pass untouched', () => {
  const r = repo();
  assert.deepEqual(smellsProblems(r, '', 'body', 0, ['example/*']), []);
  assert.deepEqual(smellsProblems(r, '', 'body', 3, ['other/*']), []);
  assert.deepEqual(smellsProblems(r, '', 'body', 3, []), []);
});

test('the CLI records, shows and reports a missing record', () => {
  const r = repo();
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: r, MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(run('show', '--repo', r).status, 1);
  const rec = run('record', '--repo', r, '--summary', 'one nit, left');
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(rec.stdout.trim(), 'Smells: one nit, left');
  assert.equal(run('show', '--repo', r).stdout.trim(), 'Smells: one nit, left');
  assert.equal(run('record', '--repo', r).status, 2);
  assert.equal(run('bogus').status, 2);
});
