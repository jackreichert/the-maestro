// Run: node --test scripts/lib/journal/env-asks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envAskText, envAsksToRaise, shellQuote } from './env-asks.ts';

const known = { repo: 'proj', worktree: '/w/a', files: ['.env', 'pkg/.env.local'], project: 'alpha', destination: '/s/proj/alpha' };
const unknown = { repo: 'proj', worktree: '/w/b', files: ['.env'], destination: '/s/proj/PROJECT' };

test('the ask names the worktree, the files, the folder and one command per file, and says so when the project is unknown', () => {
  const text = envAskText(known);
  assert.match(text, /worktree \/w\/a holds real env file\(s\) \.env, pkg\/\.env\.local/);
  assert.match(text, /suggested folder \/s\/proj\/alpha\//);
  assert.match(text, /node '[^']*\/env-store-move\.ts' '\/w\/a' '\.env' alpha && node '[^']*\/env-store-move\.ts' '\/w\/a' 'pkg\/\.env\.local' alpha$/);
  const u = envAskText(unknown);
  assert.match(u, /project unknown \(pick one: it becomes the folder under \/s\/proj\/\)/);
  assert.match(u, /'\/w\/b' '\.env' PROJECT$/);
});

test('arguments are single-quoted so a path with spaces or shell syntax pastes safely', () => {
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.match(envAskText({ ...unknown, files: ['.env.$(touch x)'] }), /'\.env\.\$\(touch x\)'/);
});

test('an ask already open with the same text, or listed twice, is raised at most once', () => {
  assert.deepEqual(envAsksToRaise([known, known, unknown], [envAskText(known)]).map((r) => r.ask.worktree), ['/w/b']);
  assert.deepEqual(envAsksToRaise([], []), []);
});
