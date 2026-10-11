// Run: node --test scripts/lib/library/stale.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStaleness, evidencePaths, realGit, sinceOf } from './stale.ts';
import type { LibraryPage } from './pages.ts';

const body = (...evidence: string[]): string => ['# Fake page', '', 'Read when: a fake question.', '', '## Facts', '', ...evidence.map((e) => `- A fake fact (verified 2026-10-01, ${e}).`), '', '## History', '', '- 2026-10-01: made up.'].join('\n');
const page = (evidence: string[], over: Partial<LibraryPage> = {}): LibraryPage => ({
  path: 'Projects/fake-repo/Knowledge/fake.md', repo: 'fake-repo', kind: 'how-it-works', title: 'Fake', readWhen: '', components: [], stream: '', status: 'current', verifiedAt: '2026-10-01', verifiedRaw: '2026-10-01', body: body(...evidence), links: [], ...over,
});

function fixtureRepo(): { root: string; dir: string; commit: (file: string, date: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'stale-'));
  const dir = join(root, 'fake-repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const git = (args: string[], date?: string): string => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
  git(['init', '-q']);
  const commit = (file: string, date: string): string => { writeFileSync(join(dir, file), `${date}\n`); git(['add', '--', file]); git(['commit', '-q', '-m', 'chore: fixture'], date); return git(['rev-parse', 'HEAD']).trim(); };
  return { root, dir, commit };
}

test('evidencePaths reads file paths from the facts only, without line suffixes, and ignores prose', () => {
  const p = page(['src/a.ts:12-30', 'src/b.py and the ledger handoff 2026-10-01', '~/.claude/hooks/guard.mjs:369']);
  assert.deepEqual(evidencePaths(p), ['src/a.ts', 'src/b.py', '~/.claude/hooks/guard.mjs']);
  assert.deepEqual(evidencePaths(page(['a ledger handoff'])), []);
});

test('sinceOf: a date means the end of that day, a sha is a range, anything else is unusable', () => {
  assert.deepEqual(sinceOf('2026-10-01'), { date: '2026-10-01T23:59:59' });
  assert.deepEqual(sinceOf('2026-10-01@abc1234'), { sha: 'abc1234' });
  assert.equal(sinceOf('soon'), null);
});

test('touching a cited evidence file after verified-at marks the page stale; an untouched one stays fresh', () => {
  const { root, commit } = fixtureRepo();
  commit('src/a.ts', '2026-09-20T10:00:00Z');
  const fresh = checkStaleness([page(['src/a.ts:1'])], root, realGit);
  assert.equal(fresh[0]?.state, 'fresh');
  commit('src/a.ts', '2026-10-05T10:00:00Z');
  const stale = checkStaleness([page(['src/a.ts:1'])], root, realGit);
  assert.equal(stale[0]?.state, 'stale');
  assert.match(stale[0]?.detail ?? '', /src\/a\.ts/);
});

test('with a sha in verified-at, only commits after that sha count, whatever their dates', () => {
  const { root, commit } = fixtureRepo();
  const sha = commit('src/a.ts', '2026-10-20T10:00:00Z');
  const p = page(['src/a.ts'], { verifiedRaw: `2026-10-01@${sha}` });
  assert.equal(checkStaleness([p], root, realGit)[0]?.state, 'fresh');
  commit('src/a.ts', '2026-10-21T10:00:00Z');
  assert.equal(checkStaleness([p], root, realGit)[0]?.state, 'stale');
});

test('a page the check cannot look at is unchecked with a reason, never fresh', () => {
  const { root, commit } = fixtureRepo();
  commit('src/a.ts', '2026-09-20T10:00:00Z');
  const [noEvidence, noRoot, noRepo, missingFile, untracked, noDate] = [
    checkStaleness([page(['a handoff'])], root, realGit)[0],
    checkStaleness([page(['src/a.ts'])], null, realGit)[0],
    checkStaleness([page(['src/a.ts'], { repo: 'other-repo' })], root, realGit)[0],
    checkStaleness([page(['src/nope.ts'])], root, realGit)[0],
    (() => { writeFileSync(join(root, 'fake-repo', 'src', 'loose.ts'), 'x'); return checkStaleness([page(['src/loose.ts'])], root, realGit)[0]; })(),
    checkStaleness([page(['src/a.ts'], { verifiedRaw: '' })], root, realGit)[0],
  ];
  assert.deepEqual([noEvidence, noRoot, noRepo, missingFile, untracked, noDate].map((r) => r?.state), Array(6).fill('unchecked'));
  assert.match(noRepo?.detail ?? '', /no checkout of other-repo/);
});

test('one stale file among several cited marks the page stale and names only that file', () => {
  const { root, commit } = fixtureRepo();
  commit('src/a.ts', '2026-09-20T10:00:00Z');
  commit('src/b.ts', '2026-10-05T10:00:00Z');
  const r = checkStaleness([page(['src/a.ts', 'src/b.ts'])], root, realGit)[0];
  assert.equal(r?.state, 'stale');
  assert.match(r?.detail ?? '', /src\/b\.ts/);
  assert.doesNotMatch(r?.detail ?? '', /src\/a\.ts/);
});
