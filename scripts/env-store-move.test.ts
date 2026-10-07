// Run: node --test scripts/env-store-move.test.ts
// Every file here is a fixture in a temp dir with obviously fake contents; no real file is ever touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./env-store-move.ts', import.meta.url).pathname;
const { moveIntoStore, MoveRefused, isStoreLink, projectFromBranch, readManifest } = await import('./lib/env-store.ts');

const FAKE = 'FAKE_KEY=not-a-secret\n';
const SENTINEL = 'FAKE_SENTINEL=sentinel-not-a-secret\n';
const git = (cwd: string, ...a: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=me@example.com', '-c', 'user.name=T', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const mode = (p: string): number => statSync(p).mode & 0o777;

/** A repo named `proj` with a linked worktree `wt`, and an empty store root beside them. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'envstore-')));
  const repo = join(root, 'proj');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  return { root, repo, wt, store: join(root, 'store') };
}
const move = (s: ReturnType<typeof setup>, file: string, project = 'alpha', over = {}) => moveIntoStore({ root: s.store, worktree: s.wt, file, project, ...over });

test('moves a real file into <store>/<repo>/<project>/, leaves a symlink, makes directories 700 and the file owner-only', () => {
  const s = setup();
  const file = '.env'; writeFileSync(join(s.wt, file), SENTINEL); chmodSync(join(s.wt, file), 0o644);
  const r = move(s, file);
  const dest = join(s.store, 'proj', 'alpha', file);
  assert.deepEqual([r.status, r.store, r.repo], ['moved', dest, 'proj'], 'repo is the main checkout, not the worktree name');
  assert.equal(lstatSync(join(s.wt, file)).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(s.wt, file)), dest);
  assert.equal(readFileSync(join(s.wt, file), 'utf8'), SENTINEL, 'readable through the link');
  assert.equal(mode(dest), 0o600);
  for (const d of [join(s.store, 'proj', 'alpha'), join(s.store, 'proj'), s.store]) assert.equal(mode(d), 0o700, d);
  assert.equal(isStoreLink(join(s.wt, file), s.store), true);
});

test('keeps an owner-only mode as it was', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env.local'), FAKE); chmodSync(join(s.wt, '.env.local'), 0o400);
  assert.equal(mode(move(s, '.env.local').store), 0o400);
});

test('refuses to overwrite a different store file and leaves the worktree file alone', () => {
  const s = setup();
  mkdirSync(join(s.store, 'proj', 'alpha'), { recursive: true });
  writeFileSync(join(s.store, 'proj', 'alpha', '.env'), 'FAKE_KEY=other-fake\n');
  writeFileSync(join(s.wt, '.env'), FAKE);
  assert.throws(() => move(s, '.env'), (e: Error) => e instanceof MoveRefused && /already exists and differs/.test(e.message));
  assert.equal(lstatSync(join(s.wt, '.env')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(s.store, 'proj', 'alpha', '.env'), 'utf8'), 'FAKE_KEY=other-fake\n');
});

test('finishes an interrupted move: same bytes already stored, original still a real file', () => {
  const s = setup();
  mkdirSync(join(s.store, 'proj', 'alpha'), { recursive: true });
  writeFileSync(join(s.store, 'proj', 'alpha', '.env'), FAKE);
  writeFileSync(join(s.wt, '.env'), FAKE);
  assert.equal(move(s, '.env').status, 'moved');
  assert.equal(lstatSync(join(s.wt, '.env')).isSymbolicLink(), true);
});

test('is idempotent: a second run is a no-op that keeps the link, the store file and one manifest row', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env'), FAKE);
  move(s, '.env');
  const before = readFileSync(join(s.store, 'manifest.json'), 'utf8');
  assert.equal(move(s, '.env').status, 'already');
  assert.equal(readFileSync(join(s.store, 'manifest.json'), 'utf8'), before);
  assert.equal(readFileSync(join(s.store, 'proj', 'alpha', '.env'), 'utf8'), FAKE);
});

test('the manifest is names only: repo, project, file and the worktrees linking to it, mode 600', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env'), SENTINEL);
  move(s, '.env');
  const wt2 = join(s.root, 'wt2'); git(s.repo, 'worktree', 'add', '-q', '-b', 'feat/y', wt2);
  mkdirSync(join(wt2, 'pkg')); writeFileSync(join(wt2, 'pkg', '.env'), FAKE);
  moveIntoStore({ root: s.store, worktree: wt2, file: 'pkg/.env', project: 'alpha' });
  symlinkSync(join(s.store, 'proj', 'alpha', '.env'), join(wt2, '.env'));
  assert.equal(moveIntoStore({ root: s.store, worktree: wt2, file: '.env', project: 'alpha' }).status, 'already');
  const m = readManifest(s.store);
  assert.deepEqual(m.files, [
    { repo: 'proj', project: 'alpha', file: '.env', worktrees: [s.wt, wt2] },
    { repo: 'proj', project: 'alpha', file: 'pkg/.env', worktrees: [wt2] },
  ]);
  assert.equal(mode(join(s.store, 'manifest.json')), 0o600);
  assert.doesNotMatch(readFileSync(join(s.store, 'manifest.json'), 'utf8'), /sentinel-not-a-secret|FAKE_KEY/);
});

test('refuses names and paths it should not move', () => {
  const s = setup();
  writeFileSync(join(s.wt, 'notes.txt'), FAKE); writeFileSync(join(s.wt, '.env.example'), FAKE);
  const outside = join(s.root, 'elsewhere'); writeFileSync(outside, FAKE);
  symlinkSync(outside, join(s.wt, '.env'));
  const cases: [string, string, RegExp][] = [
    ['notes.txt', 'alpha', /not an environment file name/], ['.env.example', 'alpha', /not an environment file name/],
    ['../.env', 'alpha', /without \.\./], [outside, 'alpha', /relative to the worktree/],
    ['.env', 'alpha', /symlink that does not point into the store/], ['.env.nope', 'alpha', /no such file/],
    ['.env', '../escape', /not a plain name/], ['.env', 'a/b', /not a plain name/],
  ];
  for (const [file, project, re] of cases) assert.throws(() => move(s, file, project), (e: Error) => e instanceof MoveRefused && re.test(e.message), `${file} ${project}`);
  assert.equal(existsSync(s.store), false, 'a refusal creates nothing');
});

test('a link into the store for a different project is refused, not re-pointed', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env'), FAKE);
  move(s, '.env', 'alpha');
  assert.throws(() => move(s, '.env', 'beta'), /different project or file/);
  assert.equal(existsSync(join(s.store, 'proj', 'beta')), false);
});

test('a repo name that would leave the store is refused', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env'), FAKE);
  assert.throws(() => move(s, '.env', 'alpha', { repo: '..' }), /not a plain name/);
  assert.throws(() => move(s, '.env', 'alpha', { repo: 'a/b' }), /not a plain name/);
  assert.equal(lstatSync(join(s.wt, '.env')).isSymbolicLink(), false);
});

test('--dry-run reports and changes nothing', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env'), FAKE);
  assert.equal(move(s, '.env', 'alpha', { dryRun: true }).status, 'would-move');
  assert.equal(existsSync(s.store), false);
  assert.equal(lstatSync(join(s.wt, '.env')).isSymbolicLink(), false);
});

test('projectFromBranch picks an existing project named in the branch, never shared, else undefined', () => {
  const s = setup();
  for (const p of ['teamselect', 'bayada', 'shared']) mkdirSync(join(s.store, 'proj', p), { recursive: true });
  assert.equal(projectFromBranch(s.store, 'proj', 'feat/PROJ-12-teamselect-writeback'), 'teamselect');
  assert.equal(projectFromBranch(s.store, 'proj', 'fix/PROJ-3-Bayada_sync'), 'bayada');
  assert.equal(projectFromBranch(s.store, 'proj', 'feat/PROJ-1-shared-thing'), undefined);
  assert.equal(projectFromBranch(s.store, 'proj', 'feat/PROJ-1-other'), undefined);
  assert.equal(projectFromBranch(s.store, 'nope', 'feat/teamselect'), undefined);
  assert.equal(projectFromBranch(s.store, 'proj', undefined), undefined);
});

test('the command line moves a file, never prints its contents, and exits 1 with a message on refusal', () => {
  const s = setup();
  writeFileSync(join(s.wt, '.env'), SENTINEL);
  const run = (...a: string[]) => spawnSync('node', [SCRIPT, ...a], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } });
  const ok = run(s.wt, '.env', 'alpha', '--store-root', s.store);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^moved: .*\.env -> .*store\/proj\/alpha\/\.env$/m);
  assert.doesNotMatch(ok.stdout + ok.stderr, /sentinel-not-a-secret/);
  assert.match(run(s.wt, '.env', 'alpha', '--store-root', s.store).stdout, /^already in the store/);
  const bad = run(s.wt, 'notes.txt', 'alpha', '--store-root', s.store);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refused: .*not an environment file name/);
  assert.equal(run().status, 2);
  assert.match(run('--help').stdout, /usage: env-store-move/);
});
