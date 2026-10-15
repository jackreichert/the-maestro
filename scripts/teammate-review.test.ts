// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/teammate-review.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submit } from './teammate-review.ts';
import { listDrafts } from './lib/drafts/queue.ts';
import { cleanup, prepare } from './lib/teammate/worktree.ts';
import type { Cmd, Runner } from './lib/teammate/worktree.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'teammate-'));
const HEAD = 'a'.repeat(40);
const text = 'Could we check for an empty list here? It looks like the first item is read without a guard.';

const NICE = 'The ID validation before anything goes into a URL is careful and easy to follow.';
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3,0 +4,1 @@', '+const first = items[0];'].join('\n');
const sub = (over: object = {}) => ({ repo: 'acme/widgets', pr: 12, head: HEAD, base: 'main', path: '/x/review-widgets-12-aaaaaaa', compliment: NICE, findings: [], ...over });

test('submit queues ONE pending review draft, applies the bar, and posts nothing (no gh is even reachable)', () => {
  const file = join(tmp(), 'J', 'drafts.jsonl');
  const out = submit(file, sub({ findings: [
    { category: 'correctness', input: 'an empty cart', failure: 'throws TypeError on items[0]', text, path: 'src/a.ts', line: 4 },
    { category: 'security', kind: 'hardening', text: `${text} (hardening)`, path: 'src/a.ts', line: 4 },
    { category: 'other', text: `${text} off the diff`, path: 'src/a.ts', line: 99 },
  ] }), DIFF);
  assert.ok(out.queued);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.downgraded, 1);
  const drafts = listDrafts(file);
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  assert.ok(d && d.state === 'pending' && d.source === 'review' && d.severity === 'review');
  assert.equal(d.review?.comments.length, 2);
  assert.ok(d.text.startsWith(NICE), 'the review opens with the compliment');
  assert.equal(submit(file, sub(), DIFF).queued, null, 'a second run for the same head neither duplicates nor adds');
});

test('submit refuses a review with no specific compliment, and a malformed head', () => {
  const file = join(tmp(), 'd.jsonl');
  const out = submit(file, sub({ compliment: 'Great work!' }), DIFF);
  assert.equal(out.queued, null);
  assert.match(out.problem ?? '', /compliment/);
  assert.equal(listDrafts(file).length, 0);
  assert.throws(() => submit(file, sub({ head: 'not-hex' }), DIFF));
});

// A real clone with a pull ref, so prepare runs actual git; gh is a stub that answers `pr view`.
function repoWithPr(): { root: string; container: string; head: string; run: Runner; viewed: string[][] } {
  const root = tmp();
  const git = (cwd: string, ...a: string[]): string => { const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const origin = join(root, 'origin'); mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main'); writeFileSync(join(origin, 'a.txt'), 'one\n'); git(origin, 'add', 'a.txt'); git(origin, 'commit', '-q', '-m', 'base');
  git(origin, 'checkout', '-q', '-b', 'feat'); writeFileSync(join(origin, 'a.txt'), 'two\n'); git(origin, 'commit', '-qam', 'change');
  const head = git(origin, 'rev-parse', 'HEAD'); git(origin, 'update-ref', 'refs/pull/12/head', head); git(origin, 'checkout', '-q', 'main');
  const container = join(root, 'container'); mkdirSync(container);
  git(container, 'clone', '-q', origin, 'widgets');
  const viewed: string[][] = [];
  const run: Runner = (cmd, args, cwd): Cmd => {
    if (cmd === 'gh') { viewed.push(args); return { status: 0, stderr: '', stdout: JSON.stringify({ author: { login: 'teammate' }, isDraft: false, state: 'OPEN', headRefOid: head, baseRefName: 'main' }) }; }
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { root, container, head, run, viewed };
}

test('prepare checks the PR head out detached and read-only; cleanup removes it again', () => {
  const r = repoWithPr();
  const worktreesDir = join(r.container, '.worktrees');
  const p = prepare({ repo: 'acme/widgets', pr: 12, self: 'me', selfRepos: [], containerRoot: r.container, worktreesDir, run: r.run });
  assert.equal(p.head, r.head);
  assert.equal(readFileSync(join(p.path, 'a.txt'), 'utf8'), 'two\n');
  const head = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: p.path, encoding: 'utf8' });
  assert.notEqual(head.status, 0, 'detached: there is no branch to commit to');
  assert.equal(statSync(join(p.path, 'a.txt')).mode & 0o222, 0, 'files are unwritable');
  assert.throws(() => writeFileSync(join(p.path, 'a.txt'), 'x'));
  assert.equal(prepare({ repo: 'acme/widgets', pr: 12, self: 'me', selfRepos: [], containerRoot: r.container, worktreesDir, run: r.run }).path, p.path, 'idempotent');
  cleanup({ repo: 'acme/widgets', path: p.path, worktreesDir, containerRoot: r.container, run: r.run });
  assert.equal(existsSync(p.path), false);
  assert.throws(() => cleanup({ repo: 'acme/widgets', path: r.container, worktreesDir, containerRoot: r.container, run: r.run }), /not a review worktree/);
  chmodSync(r.container, 0o755);
});

test('prepare refuses your own PR, a self-review repo, a draft and a closed PR, and never runs git for them', () => {
  const r = repoWithPr();
  const base = { repo: 'acme/widgets', pr: 12, self: 'me', selfRepos: [] as string[], containerRoot: r.container, worktreesDir: join(r.container, '.worktrees') };
  const as = (view: object): Runner => (cmd, args, cwd) => (cmd === 'gh' ? { status: 0, stderr: '', stdout: JSON.stringify({ headRefOid: r.head, baseRefName: 'main', state: 'OPEN', isDraft: false, author: { login: 'teammate' }, ...view }) } : r.run(cmd, args, cwd));
  assert.throws(() => prepare({ ...base, self: 'Teammate', run: r.run }), /your own/);
  assert.throws(() => prepare({ ...base, selfRepos: ['acme/*'], run: r.run }), /self-review/);
  assert.throws(() => prepare({ ...base, run: as({ isDraft: true }) }), /not open and ready/);
  assert.throws(() => prepare({ ...base, run: as({ state: 'MERGED' }) }), /not open and ready/);
  assert.throws(() => prepare({ ...base, run: as({ baseRefName: '--upload-pack=x' }) }), /base/);
  assert.equal(existsSync(join(r.container, '.worktrees')), false);
});

test('prepare and submit contain no call that posts: the helper only reads and queues', () => {
  for (const f of ['teammate-review.ts', 'lib/teammate/worktree.ts', 'lib/teammate/bar.ts', 'lib/teammate/wait.ts', 'lib/teammate/firstpass.ts']) {
    const src = readFileSync(join(import.meta.dirname, f), 'utf8');
    assert.equal(/approveAndPost|drafts\/post\.ts|'comments'|pr', 'comment|pr', 'review|'--method'|-X', 'POST/.test(src), false, f);
  }
});

test('firstpass reads the PR body, bot findings, CI rollup and each changed package test command; install runs npm ci only where a lockfile is and reports git status', async () => {
  const { firstPass, installDeps } = await import('./lib/teammate/firstpass.ts');
  const root = tmp();
  mkdirSync(join(root, 'pkg-a', 'src'), { recursive: true }); mkdirSync(join(root, 'pkg-b'), { recursive: true });
  writeFileSync(join(root, 'pkg-a', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } })); writeFileSync(join(root, 'pkg-a', 'package-lock.json'), '{}');
  writeFileSync(join(root, 'pkg-b', 'package.json'), '{}');
  const view = { title: 'Add widgets', body: 'Adds widgets.', files: [{ path: 'pkg-a/src/x.ts' }, { path: 'pkg-b/y.ts' }, { path: 'README.md' }],
    comments: [{ author: { login: 'copilot-pull-request-reviewer' }, body: 'Possible null here' }, { author: { login: 'jane' }, body: 'human note' }],
    reviews: [{ author: { login: 'dependabot[bot]' }, body: 'bump', state: 'COMMENTED' }],
    statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }, { name: 'lint', conclusion: 'SUCCESS' }, { name: 'gates', status: 'IN_PROGRESS' }] };
  const run: Runner = () => ({ status: 0, stderr: '', stdout: JSON.stringify(view) });
  const fp = firstPass({ repo: 'acme/widgets', pr: 12, path: root, run });
  assert.deepEqual(fp.botFindings.map((f) => f.author), ['copilot-pull-request-reviewer', 'dependabot[bot]']);
  assert.deepEqual(fp.ci, { total: 3, failing: ['test'], pending: 1 });
  assert.deepEqual(fp.packages.map((p) => [p.dir, p.test, p.files]), [['pkg-a', 'node --test', 1], ['pkg-b', null, 1]]);
  const calls: string[] = []; let env: NodeJS.ProcessEnv = {};
  const res = installDeps({ path: root, packages: fp.packages, containerRoot: root, env: { PATH: '/bin', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y' }, exec: (cmd, args, cwd, e) => { calls.push(`${cmd} ${args.join(' ')} ${cwd.slice(root.length)}`); env = e; return { status: 0, stdout: cmd === 'git' ? ' M bin/x\n' : '', stderr: '' }; } });
  assert.deepEqual(calls, ['npm ci --ignore-scripts --no-audit --no-fund /pkg-a', 'git status --porcelain ']);
  assert.deepEqual(res.skipped, ['pkg-b']);
  assert.deepEqual(res.dirty, [' M bin/x']);
  assert.equal(env.PUPPETEER_SKIP_DOWNLOAD, '1');
  assert.equal(env.GH_TOKEN, undefined, 'no token reaches the PR\'s code');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NPM_CONFIG_USERCONFIG, undefined, 'no .npmrc in the container folder, so none is named');
  writeFileSync(join(root, '.npmrc'), '');
  installDeps({ path: root, packages: fp.packages, containerRoot: root, env: { PATH: '/bin' }, exec: (_c, _a, _d, e) => { env = e; return { status: 0, stdout: '', stderr: '' }; } });
  assert.equal(env.NPM_CONFIG_USERCONFIG, join(root, '.npmrc'));
});

test('a push retires the earlier review draft that is still waiting, with the reason on record, and leaves nothing posted', () => {
  const file = join(tmp(), 'J', 'drafts.jsonl');
  submit(file, sub({ head: 'a'.repeat(40) }), DIFF);
  submit(file, sub({ head: 'b'.repeat(40) }), DIFF);
  const ds = listDrafts(file);
  assert.deepEqual(ds.map((d) => d.state), ['rejected', 'pending']);
  assert.match(ds[0]?.rejectReason ?? '', /superseded by a newer push \(bbbbbbb\)/);
});

test('the PR author prepare printed is kept on the draft, so the needs-you list can name them; a bad login is left off, not allowed to lose the review', () => {
  const file = join(tmp(), 'J', 'drafts.jsonl');
  assert.ok(submit(file, sub({ author: 'robin-r' }), DIFF).queued);
  assert.equal(listDrafts(file)[0]?.author, 'robin-r');
  const other = join(tmp(), 'J', 'drafts.jsonl');
  assert.ok(submit(other, sub({ author: 'not a login; rm -rf' }), DIFF).queued, 'a display field never costs the review');
  assert.equal(listDrafts(other)[0]?.author, undefined);
  const none = join(tmp(), 'J', 'drafts.jsonl');
  assert.ok(submit(none, sub({ author: '' }), DIFF).queued);
  assert.equal(listDrafts(none)[0]?.author, undefined, 'an unknown author is left off, not stored empty');
});

test('smell findings are kept on the first round of a PR and dropped on every later round', () => {
  const file = join(tmp(), 'r.jsonl');
  const smell = { source: 'smell', category: 'other', cost: 'the next edit has to touch both copies', text, path: 'src/a.ts', line: 4 };
  assert.equal(submit(file, sub({ findings: [smell] }), DIFF).queued !== null, true);
  assert.equal(listDrafts(file)[0]?.review?.comments.length, 1);
  const NEW = 'b'.repeat(40);
  const again = submit(file, sub({ head: NEW, findings: [smell, { category: 'other', text: `${text} again`, path: 'src/a.ts', line: 4 }] }), DIFF);
  assert.ok(again.queued);
  const latest = listDrafts(file).find((d) => d.id === again.queued?.id);
  assert.equal(latest?.review?.comments.length, 1, 'only the reviewer finding is kept');
});
