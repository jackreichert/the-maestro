// Cases for branch-sweep; run through branch-sweep.shard-N.test.ts (see lib/shard.ts)
import { test } from './lib/shard.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, symlinkSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic: never read the user's config file (see local-config.ts).
process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.MAESTRO_LAUNCH_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'agents-')); // and never the real launchd plist
const SCRIPT = new URL('./branch-sweep.ts', import.meta.url).pathname;
import type { CmdResult, ExcludedItem, Git, GhJson, ListedItem, PrInfo, SweepContext } from './branch-sweep.ts';
const { scanRepo, apply, deleteRemoteBranch, defaultContext, explain, branchGlob, sweepWorktrees, removeWorktree, worktreeSweepLines, keptCounts, isEnvFile } = await import('./branch-sweep.ts');

const ME = 'me@example.com';
type World = ReturnType<typeof world>;
/** A value a test expects to be present (a find() that must hit). */
function must<T>(v: T | undefined, label = 'value'): T {
    assert.ok(v !== undefined, label);
    return v;
}
const sh = (repo: string, ...args: string[]): string => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};
const commit = (repo: string, file: string, text: string, email = ME): void => {
    writeFileSync(join(repo, file), text);
    sh(repo, 'add', file);
    sh(repo, '-c', `user.email=${email}`, '-c', 'user.name=T', 'commit', '-q', '-m', `edit ${file}`);
};

/** A container holding `name`, a clone of a bare origin that has main, develop and staging at one commit. */
function world(name = 'proj') {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-')));  // git reports real paths (macOS: /private/var)
    const origin = join(root, 'origin.git');
    const repo = join(root, 'box', name);
    mkdirSync(join(root, 'box'));
    sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
    sh(root, 'clone', '-q', origin, repo);
    for (const [k, v] of [['user.email', ME], ['user.name', 'T'], ['core.hooksPath', '/dev/null']]) sh(repo, 'config', k, v);
    commit(repo, 'base.txt', 'base\n');
    for (const b of ['develop', 'staging']) sh(repo, 'branch', b);
    sh(repo, 'push', '-q', '-u', 'origin', 'main', 'develop', 'staging');
    sh(repo, 'remote', 'set-head', 'origin', 'main');
    return { root, container: join(root, 'box'), repo, origin, name };
}
/** Pushes a branch with one commit of its own, then returns to main. */
function feature(w: World, branch: string, { email = ME, file = `${branch.replace(/\W/g, '_')}.txt` }: { email?: string; file?: string } = {}): void {
    sh(w.repo, 'checkout', '-q', '-b', branch, 'main');
    commit(w.repo, file, `${branch}\n`, email);
    sh(w.repo, 'push', '-q', '-u', 'origin', branch);
    sh(w.repo, 'checkout', '-q', 'main');
}
const mergeInto = (w: World, target: string, branch: string, squash = false): void => {
    sh(w.repo, 'checkout', '-q', target);
    if (squash) { sh(w.repo, 'merge', '--squash', branch); sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'squash'); }
    else sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'merge', '-q', '--no-ff', '-m', 'merge', branch);
    sh(w.repo, 'push', '-q', 'origin', target);
    sh(w.repo, 'checkout', '-q', 'main');
};
const ctxFor = (over: Partial<SweepContext> = {}) => defaultContext({ emails: [ME], twin: [], idleMinutes: 0, claims: new Map(), gh: () => null, ghLogin: 'me-login', ...over });
const names = (r: { items: ListedItem[] }, kind: string): string[] => r.items.filter((i) => i.kind === kind).map((i) => i.name);
const remoteHas = (w: World, branch: string): boolean => sh(w.repo, 'ls-remote', '--heads', 'origin', branch) !== '';

test('merged into develop and staging qualifies in a twin-flow repo', () => {
    const w = world(); feature(w, 'feat/a');
    mergeInto(w, 'develop', 'feat/a'); mergeInto(w, 'staging', 'feat/a');
    const r = scanRepo(w.repo, ctxFor({ twin: ['proj'] }));
    assert.deepEqual(names(r, 'remote-branch'), ['feat/a']);
    assert.match(r.items[0].why, /develop \(ancestry\) and staging \(ancestry\)/);
});

test('a second remote with its own HEAD ref is never scanned as a branch', () => {
    const w = world(); feature(w, 'feat/a');
    mergeInto(w, 'develop', 'feat/a');
    const second = join(w.root, 'second.git');
    sh(w.root, 'clone', '-q', '--bare', w.origin, second);
    sh(w.repo, 'remote', 'add', 'second', second);
    sh(w.repo, 'fetch', '-q', 'second');
    sh(w.repo, 'remote', 'set-head', 'second', '-a');
    assert.match(sh(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/second'), /refs\/remotes\/second\/HEAD/);   // the ref exists
    const r = scanRepo(w.repo, ctxFor());
    assert.deepEqual(names(r, 'remote-branch'), ['feat/a']);
    assert.deepEqual(r.notes, []);
});

test('merged into develop only does not qualify in a twin-flow repo, but does elsewhere', () => {
    const w = world(); feature(w, 'feat/a'); mergeInto(w, 'develop', 'feat/a');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ twin: ['proj'] })), 'remote-branch'), []);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), ['feat/a']);
});

test('a squash merge is evidence only with its merged PR; cherry alone goes to review, and apply refuses it', () => {
    const w = world(); feature(w, 'feat/sq'); mergeInto(w, 'develop', 'feat/sq', true);
    assert.notEqual(spawnSync('git', ['-C', w.repo, 'merge-base', '--is-ancestor', 'origin/feat/sq', 'origin/develop']).status, 0, 'not an ancestor');
    const r = scanRepo(w.repo, ctxFor({ gh: () => [] }));
    assert.deepEqual([names(r, 'remote-branch'), r.review.map((i) => i.name)], [[], ['feat/sq']]);
    assert.match(r.review[0].why, /develop \(patch-equivalent only\)/);
    const [res] = apply([r.review[0].id], w.container, ctxFor({ gh: () => [] }));
    assert.match(res.message, /refused: patch-equivalent only/);
    assert.equal(remoteHas(w, 'feat/sq'), true);
    const tip = sh(w.repo, 'rev-parse', 'origin/feat/sq');
    const pr = () => [{ number: 5, headRefName: 'feat/sq', baseRefName: 'develop', headRefOid: tip, url: 'https://example.com/pull/5', body: '' }];
    const merged = scanRepo(w.repo, ctxFor({ gh: pr }));
    assert.deepEqual([names(merged, 'remote-branch'), merged.review], [['feat/sq'], []]);
    assert.match(merged.items[0].why, /develop \(PR #5\)/);
});

test('a squash merge that was reverted on develop still only reads as review', () => {
    const w = world(); feature(w, 'feat/rev'); mergeInto(w, 'develop', 'feat/rev', true);
    sh(w.repo, 'checkout', '-q', 'develop'); sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'revert', '--no-edit', 'HEAD'); sh(w.repo, 'push', '-q', 'origin', 'develop'); sh(w.repo, 'checkout', '-q', 'main');
    const r = scanRepo(w.repo, ctxFor({ gh: () => [] }));
    assert.deepEqual([names(r, 'remote-branch'), r.review.map((i) => i.name)], [[], ['feat/rev']]);
});

test('protected branches are never listed, even when fully merged', () => {
    const w = world(); feature(w, 'release');
    mergeInto(w, 'develop', 'release');
    const r = scanRepo(w.repo, ctxFor({ protectedNames: ['main', 'staging', 'develop', 'release'] }));
    assert.deepEqual(names(r, 'remote-branch'), []);
});

test('a branch with a foreign author is never listed', () => {
    const w = world(); feature(w, 'feat/theirs', { email: 'other@example.com' }); mergeInto(w, 'develop', 'feat/theirs');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), []);
});

const pr = (number: number, base: string, head: string, oid: string, body = ''): PrInfo => ({ number, baseRefName: base, headRefName: head, headRefOid: oid, url: `https://example.com/pull/${number}`, body, mergedAt: daysAgo(1), author: { login: 'me-login' } });
const tipOf = (w: World, b: string): string => sh(w.repo, 'rev-parse', `origin/${b}`);
/** Branches x and its twin merged into develop and staging respectively, as separate branches (squash, so ancestry is no evidence). */
function twins(w: World, x: string, twin: string, { xTarget = 'develop', twinTarget = 'staging' } = {}): void {
    feature(w, x); feature(w, twin);
    mergeInto(w, xTarget, x, true); mergeInto(w, twinTarget, twin, true);
}
const kept = (w: World, prs: PrInfo[], over: Partial<SweepContext> = {}) => names(scanRepo(w.repo, ctxFor({ twin: ['proj'], gh: searchGh(prs), ...over })), 'remote-branch').sort();

test('twin flow: x merged into develop and x-staging into staging qualify each other, with the tip bound', () => {
    const w = world(); twins(w, 'fix/x', 'fix/x-staging');
    const prs = [pr(1, 'develop', 'fix/x', tipOf(w, 'fix/x')), pr(2, 'staging', 'fix/x-staging', tipOf(w, 'fix/x-staging'))];
    assert.deepEqual(kept(w, prs), ['fix/x', 'fix/x-staging']);
    const r = scanRepo(w.repo, ctxFor({ twin: ['proj'], gh: searchGh(prs) }));
    assert.match(must(r.items.find((i) => i.name === 'fix/x')).why, /develop \(PR #1\) and staging \(twin PR #2 \(fix\/x-staging\)\)/);
    assert.deepEqual(must(r.items.find((i) => i.name === 'fix/x')).prs, ['https://example.com/pull/1', 'https://example.com/pull/2']);
    assert.deepEqual(kept(w, [pr(1, 'develop', 'fix/x', '0'.repeat(40)), prs[1]]), [], 'x moved on since PR 1, so x is out, and x-staging has no twin whose branch still sits at its PR head');
});

test('twin flow: the -develop naming works too (x into staging, x-develop into develop)', () => {
    const w = world(); twins(w, 'fix/y', 'fix/y-develop', { xTarget: 'staging', twinTarget: 'develop' });
    assert.deepEqual(kept(w, [pr(1, 'staging', 'fix/y', tipOf(w, 'fix/y')), pr(2, 'develop', 'fix/y-develop', tipOf(w, 'fix/y-develop'))]), ['fix/y', 'fix/y-develop']);
});

test('twin flow: without a merged twin, or with an unrelated PR into staging, nothing qualifies', () => {
    const w = world(); twins(w, 'fix/x', 'fix/other');
    const own = pr(1, 'develop', 'fix/x', tipOf(w, 'fix/x'));
    assert.deepEqual(kept(w, [own]), [], 'no staging PR (the twin is open or unmerged, so never listed)');
    assert.deepEqual(kept(w, [own, pr(2, 'staging', 'fix/other', tipOf(w, 'fix/other'))]), [], 'different name, no link');
    assert.deepEqual(kept(w, [pr(2, 'staging', 'fix/x-staging', tipOf(w, 'fix/other'))]), [], 'a staging PR alone: x has no merged develop PR');
});

test('twin flow: the same branch name into staging with another head is not x\'s twin', () => {
    const w = world(); feature(w, 'fix/x'); mergeInto(w, 'develop', 'fix/x', true);
    const prs = [pr(1, 'develop', 'fix/x', tipOf(w, 'fix/x')), pr(2, 'staging', 'fix/x', 'a'.repeat(40))];
    assert.deepEqual(kept(w, prs), []);
});

test('twin flow: differently named twins count only when both bodies link each other', () => {
    const w = world(); twins(w, 'fix/a', 'fix/b');
    const [ta, tb] = [tipOf(w, 'fix/a'), tipOf(w, 'fix/b')];
    assert.deepEqual(kept(w, [pr(1, 'develop', 'fix/a', ta, 'staging twin: #2'), pr(2, 'staging', 'fix/b', tb, 'develop twin: /pull/1')]), ['fix/a', 'fix/b']);
    assert.deepEqual(kept(w, [pr(1, 'develop', 'fix/a', ta, 'follow-up to #2'), pr(2, 'staging', 'fix/b', tb, 'no link')]), [], 'a one-way mention is not a twin');
    assert.deepEqual(kept(w, [pr(1, 'develop', 'fix/a', ta, ''), pr(2, 'staging', 'fix/b', tb, 'twin of #1')]), [], 'a one-way mention is not a twin');
});

test('non-twin repos and develop-only merges are unchanged by the twin rule', () => {
    const w = world(); feature(w, 'fix/x'); mergeInto(w, 'develop', 'fix/x', true);
    const prs = [pr(1, 'develop', 'fix/x', tipOf(w, 'fix/x')), pr(2, 'staging', 'fix/x-staging', 'b'.repeat(40))];
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: searchGh(prs) })), 'remote-branch'), ['fix/x']);
});

test('a clean worktree on a merged branch qualifies; a dirty one is kept and reported', () => {
    const w = world(); feature(w, 'feat/clean'); feature(w, 'feat/dirty'); feature(w, 'feat/loose');
    for (const b of ['feat/clean', 'feat/dirty', 'feat/loose']) { mergeInto(w, 'develop', b); sh(w.repo, 'worktree', 'add', '-q', join(w.root, b.replace('/', '-')), b); }
    writeFileSync(join(w.root, 'feat-dirty', 'feat_dirty.txt'), 'changed\n');
    writeFileSync(join(w.root, 'feat-loose', 'scratch.txt'), 'x\n');
    const r = scanRepo(w.repo, ctxFor());
    assert.deepEqual(names(r, 'worktree').map((p) => p.split('/').pop()), ['feat-clean']);
    assert.match(must(r.excluded.find((e: ExcludedItem) => e.name.endsWith('feat-dirty'))).reason, /uncommitted changes/);
    assert.match(must(r.excluded.find((e) => e.name.endsWith('feat-loose'))).reason, /1 untracked files/);
});

test('a worktree a skill directory symlinks to (or into) is kept as a live skill', () => {
    const w = world();
    for (const b of ['feat/live', 'feat/inside', 'feat/extra', 'feat/plain']) { feature(w, b); mergeInto(w, 'develop', b); sh(w.repo, 'worktree', 'add', '-q', join(w.root, b.replace('/', '-')), b); }
    const skills = join(w.container, '.claude', 'skills'); mkdirSync(skills, { recursive: true });
    symlinkSync(join(w.root, 'feat-live'), join(skills, 'live'));
    symlinkSync(join(w.root, 'feat-inside', 'feat_inside.txt'), join(skills, 'inside')); // points at a file inside the worktree
    const extra = join(w.root, 'extra-skills'); mkdirSync(extra);
    symlinkSync(join(w.root, 'feat-extra'), join(extra, 'x'));
    const r = scanRepo(w.repo, ctxFor({ protectDirs: [extra] }));
    assert.deepEqual(names(r, 'worktree').map((p) => p.split('/').pop()), ['feat-plain']);
    assert.equal(r.excluded.filter((e) => /live skill/.test(e.reason)).length, 3);
});

test('a worktree with ignored files that are not disposable is kept, with the reason; disposable ones do not keep it', () => {
    const w = world();
    sh(w.repo, 'checkout', '-q', '-b', 'feat/ign', 'main');
    writeFileSync(join(w.repo, '.gitignore'), 'secret.key\nlocal.db\nnode_modules/\n__pycache__/\n'); sh(w.repo, 'add', '.gitignore');
    sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'ignore'); sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/ign'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/ign');
    const wt = join(w.root, 'ign'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/ign');
    mkdirSync(join(wt, 'node_modules')); writeFileSync(join(wt, 'node_modules', 'a.js'), 'x');
    mkdirSync(join(wt, 'pkg', '__pycache__'), { recursive: true }); writeFileSync(join(wt, 'pkg', '__pycache__', 'a.pyc'), 'x');
    assert.equal(names(scanRepo(w.repo, ctxFor()), 'worktree').length, 1, 'only disposable ignored paths: it qualifies');
    writeFileSync(join(wt, 'secret.key'), 'placeholder\n'); writeFileSync(join(wt, 'local.db'), 'x');
    const r = scanRepo(w.repo, ctxFor());
    assert.deepEqual(names(r, 'worktree'), []);
    assert.match(r.excluded[0].reason, /2 ignored files kept \(.*secret\.key.*\): not disposable/);
    assert.equal(names(scanRepo(w.repo, ctxFor({ disposableIgnored: ['secret.key', 'local.db', 'node_modules', '__pycache__'] })), 'worktree').length, 1);
});

test('a worktree holding an ignored environment file is kept and listed, even when the settings call its path disposable', () => {
    const w = world();
    sh(w.repo, 'checkout', '-q', '-b', 'feat/envf', 'main');
    writeFileSync(join(w.repo, '.gitignore'), '.env*\nssm-*.json\nnode_modules/\n'); sh(w.repo, 'add', '.gitignore');
    sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'ignore'); sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/envf'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/envf');
    const wt = join(w.root, 'envf'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/envf');
    assert.equal(names(scanRepo(w.repo, ctxFor()), 'worktree').length, 1, 'clean: it qualifies');
    writeFileSync(join(wt, '.env.local'), 'KEY=placeholder\n');
    for (const disposableIgnored of [undefined, ['.env.local', '.env', 'node_modules']]) {
        const r = scanRepo(w.repo, ctxFor(disposableIgnored ? { disposableIgnored } : {}));
        assert.deepEqual(names(r, 'worktree'), []);
        assert.match(r.excluded[0].reason, /1 environment files \(\.env\.local\): may be the only copy/);
    }
    rmSync(join(wt, '.env.local'));
    writeFileSync(join(wt, 'ssm-fake.json'), '{}\n');
    assert.match(scanRepo(w.repo, ctxFor()).excluded[0].reason, /environment files \(ssm-fake\.json\)/);
});

test('isEnvFile names env and secrets-export files, not templates or lookalikes', () => {
    for (const p of ['.env', '.env.local', '.env.production', 'app/.env', 'ssm-prod.json']) assert.equal(isEnvFile(p), true, p);
    for (const p of ['.env.example', '.env.sample', '.env.template', 'environment.ts', 'env', '.envrc', 'ssm.json', 'notes/ssm-x.txt', '']) assert.equal(isEnvFile(p), false, p);
});

test('removeWorktree refuses a worktree holding an environment file, even when the caller passes it as disposable', () => {
    const w = world();
    writeFileSync(join(w.repo, '.gitignore'), '.env\n'); sh(w.repo, 'add', '.gitignore');
    sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'ignore'); sh(w.repo, 'push', '-q', 'origin', 'main');
    const wt = join(w.root, 'envrm'); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
    const [item] = scanRepo(w.repo, ctxFor({ gh: () => [] })).items.filter((i) => i.name === wt);
    writeFileSync(join(wt, '.env'), 'KEY=placeholder\n');
    assert.match(removeWorktree(w.repo, item, item.id, ['.env']).message, /holds an environment file/);
    assert.equal(existsSync(join(wt, '.env')), true);
});

/** A merged feature branch whose worktree ignores env files, with an env store beside it: { w, wt, store }. All file contents are obviously fake. */
function envWorld(branch = 'feat/envs', ignore = true) {
    const w = world();
    sh(w.repo, 'checkout', '-q', '-b', branch, 'main');
    const file = ignore ? '.gitignore' : 'other.txt'; // without a .gitignore the env files show up as untracked
    writeFileSync(join(w.repo, file), '.env*\nssm-*.json\n'); sh(w.repo, 'add', file);
    sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'ignore'); sh(w.repo, 'push', '-q', '-u', 'origin', branch); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', branch);
    const wt = join(w.root, 'envwt'); sh(w.repo, 'worktree', 'add', '-q', wt, branch);
    const store = join(w.root, 'store'); mkdirSync(join(store, w.name, 'alpha'), { recursive: true });
    return { w, wt, store };
}
const FAKE = 'FAKE_KEY=not-a-secret\n';

test('a worktree whose env files are symlinks into the env store qualifies, and removing it leaves the store file untouched', () => {
    const { w, wt, store } = envWorld();
    const target = join(store, w.name, 'alpha', '.env'); writeFileSync(target, FAKE);
    symlinkSync(target, join(wt, '.env'));
    const ctx = ctxFor({ envStoreRoot: store });
    const r = scanRepo(w.repo, ctx);
    assert.deepEqual(names(r, 'worktree'), [wt]);
    assert.deepEqual(r.envAsks, []);
    const item = must(r.items.find((i) => i.kind === 'worktree'));
    assert.equal(removeWorktree(w.repo, item, item.id, ctx.disposableIgnored, store).done, true);
    assert.equal(existsSync(wt), false);
    assert.equal(readFileSync(target, 'utf8'), FAKE, 'the link target is never deleted');
});

test('the roll sweep removes a store-linked worktree and keeps the store file', () => {
    const { w, wt, store } = envWorld();
    const target = join(store, w.name, 'alpha', '.env.local'); writeFileSync(target, FAKE);
    symlinkSync(target, join(wt, '.env.local'));
    const out = sweepWorktrees(w.container, ctxFor({ envStoreRoot: store }));
    assert.deepEqual(out.removed.map((x) => x.path), [wt]);
    assert.deepEqual(out.envAsks, []);
    assert.equal(readFileSync(target, 'utf8'), FAKE);
});

test('a store link that git does not ignore is untracked, so the worktree is kept as for any untracked file (git refuses to remove it without --force)', () => {
    const { w, wt, store } = envWorld('feat/envs', false);
    const target = join(store, w.name, 'alpha', '.env.local'); writeFileSync(target, FAKE);
    symlinkSync(target, join(wt, '.env.local'));
    const out = sweepWorktrees(w.container, ctxFor({ envStoreRoot: store }));
    assert.deepEqual(out.removed, []);
    assert.match(out.kept[0]?.reason ?? '', /1 untracked files/);
    assert.equal(existsSync(wt), true);
});

test('a dangling link into the store is removable; a link pointing outside the store is a real env file and keeps the worktree', () => {
    const { w, wt, store } = envWorld();
    symlinkSync(join(store, w.name, 'alpha', '.env'), join(wt, '.env')); // target not there yet
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ envStoreRoot: store })), 'worktree'), [wt]);
    rmSync(join(wt, '.env'));
    const elsewhere = join(w.root, 'elsewhere.txt'); writeFileSync(elsewhere, FAKE);
    symlinkSync(elsewhere, join(wt, '.env'));
    const r = scanRepo(w.repo, ctxFor({ envStoreRoot: store }));
    assert.deepEqual(names(r, 'worktree'), []);
    assert.match(r.excluded[0].reason, /1 environment files \(\.env\)/);
    // a sibling directory whose name merely starts with the store's name is not inside it
    rmSync(join(wt, '.env'));
    const lookalike = join(w.root, 'store-evil'); mkdirSync(lookalike); writeFileSync(join(lookalike, '.env'), FAKE);
    symlinkSync(join(lookalike, '.env'), join(wt, '.env'));
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ envStoreRoot: store })), 'worktree'), []);
});

test('a real env file keeps the worktree and raises an ask with names only: the project from the branch when the store has it, else unknown', () => {
    const { w, wt, store } = envWorld('feat/PROJ-1-alpha-fix');
    writeFileSync(join(wt, '.env'), 'FAKE_SENTINEL=sentinel-not-a-secret\n');
    const r = scanRepo(w.repo, ctxFor({ envStoreRoot: store }));
    assert.deepEqual(names(r, 'worktree'), []);
    assert.deepEqual(r.envAsks, [{ repo: w.name, worktree: wt, files: ['.env'], project: 'alpha', destination: join(store, w.name, 'alpha') }]);
    assert.doesNotMatch(JSON.stringify(r), /sentinel-not-a-secret/);
    const unknown = scanRepo(w.repo, ctxFor({ envStoreRoot: join(w.root, 'empty-store') }));
    assert.equal(unknown.envAsks[0].project, undefined);
    assert.match(unknown.envAsks[0].destination, /PROJECT$/);
    assert.equal(existsSync(join(wt, '.env')), true);
});

test('a worktree kept for another reason (uncommitted change) raises no env ask', () => {
    const { w, wt, store } = envWorld();
    writeFileSync(join(wt, '.env'), FAKE); writeFileSync(join(wt, 'notes.txt'), 'x');
    assert.deepEqual(scanRepo(w.repo, ctxFor({ envStoreRoot: store })).envAsks, []);
});

test('no env ask when another rule would still keep the worktree: an unignored file, or not idle yet', () => {
    const { w, wt, store } = envWorld();
    writeFileSync(join(wt, '.env'), FAKE);
    assert.equal(scanRepo(w.repo, ctxFor({ envStoreRoot: store })).envAsks.length, 1, 'only the env file blocks: it asks');
    assert.deepEqual(scanRepo(w.repo, ctxFor({ envStoreRoot: store, idleMinutes: 24 * 60 * 365 })).envAsks, [], 'not idle yet');
    writeFileSync(join(wt, 'build.log'), 'x');
    assert.deepEqual(scanRepo(w.repo, ctxFor({ envStoreRoot: store })).envAsks, [], 'an untracked file would keep it too');
});

test('removeWorktree still refuses a real env file next to a store link', () => {
    const { w, wt, store } = envWorld();
    const target = join(store, w.name, 'alpha', '.env'); writeFileSync(target, FAKE);
    symlinkSync(target, join(wt, '.env'));
    const ctx = ctxFor({ envStoreRoot: store });
    const item = must(scanRepo(w.repo, ctx).items.find((i) => i.kind === 'worktree'));
    writeFileSync(join(wt, '.env.local'), FAKE);
    assert.match(removeWorktree(w.repo, item, item.id, ctx.disposableIgnored, store).message, /holds an environment file/);
    assert.equal(existsSync(wt), true);
});

test('a worktree whose upstream is gone qualifies only with nothing unpushed; claimed or recently touched ones are kept', () => {
    const w = world(); feature(w, 'feat/gone');
    const wt = join(w.root, 'gone'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/gone');
    sh(w.repo, 'push', '-q', 'origin', '--delete', 'feat/gone');
    commit(wt, 'local.txt', 'unpushed\n');
    assert.match(scanRepo(w.repo, ctxFor()).excluded[0].reason, /2 commit\(s\) are not pushed or merged/);
    sh(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/kept'); // everything now reachable from a remote ref
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'worktree').map((p) => p.split('/').pop()), ['gone']);
    assert.match(scanRepo(w.repo, ctxFor({ claims: new Map([['proj', { desk: 'Launch' }]]) })).excluded[0].reason, /claimed by Launch/);
    assert.match(scanRepo(w.repo, ctxFor({ idleMinutes: 600 })).excluded[0].reason, /idle window 600/);
});

test('a colleague\'s commits plus my fix, merged --no-ff, are not mine; a bot branch is not mine', () => {
    const w = world();
    sh(w.repo, 'checkout', '-q', '-b', 'feat/shared', 'main');
    commit(w.repo, 'c1.txt', '1\n', 'colleague@example.com'); commit(w.repo, 'c2.txt', '2\n', 'colleague@example.com'); commit(w.repo, 'mine.txt', 'fix\n');
    sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/shared'); sh(w.repo, 'checkout', '-q', 'main');
    feature(w, 'feat/bot', { email: 'dependabot@example.com' });
    for (const b of ['feat/shared', 'feat/bot']) mergeInto(w, 'develop', b);
    feature(w, 'feat/mine'); mergeInto(w, 'develop', 'feat/mine');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), ['feat/mine']);
});

test('a colleague\'s back-merge branch with no commits of its own is not mine, even when merged into a glob-protected release/* branch', () => {
    const w = world();
    const OTHER = 'samwise@example.com';
    sh(w.repo, 'branch', 'release/1.0', 'main'); sh(w.repo, 'push', '-q', 'origin', 'release/1.0');
    feature(w, 'feat/mine');
    mergeInto(w, 'release/1.0', 'feat/mine');
    // The colleague cut a branch from main and merged release/1.0 in: one merge commit, nothing of their own.
    sh(w.repo, 'checkout', '-q', '-b', 'colleague/x', 'main');
    sh(w.repo, '-c', `user.email=${OTHER}`, '-c', 'user.name=S', 'merge', '-q', '--no-ff', '-m', 'sync release', 'release/1.0');
    sh(w.repo, 'push', '-q', 'origin', 'colleague/x');
    // release moves on, then takes the back-merge; develop takes it too.
    sh(w.repo, 'checkout', '-q', 'release/1.0'); commit(w.repo, 'rel.txt', 'r\n', OTHER); sh(w.repo, 'push', '-q', 'origin', 'release/1.0');
    sh(w.repo, '-c', `user.email=${OTHER}`, '-c', 'user.name=S', 'merge', '-q', '--no-ff', '-m', 'merge', 'colleague/x'); sh(w.repo, 'push', '-q', 'origin', 'release/1.0');
    sh(w.repo, 'checkout', '-q', 'develop');
    sh(w.repo, '-c', `user.email=${OTHER}`, '-c', 'user.name=S', 'merge', '-q', '--no-ff', '-m', 'merge', 'colleague/x'); sh(w.repo, 'push', '-q', 'origin', 'develop');
    sh(w.repo, 'push', '-q', 'origin', '--delete', 'feat/mine');
    sh(w.repo, 'fetch', '-q', '--prune', 'origin'); sh(w.repo, 'checkout', '-q', 'main');
    const ctx = ctxFor({ gh: searchGh([]) });
    assert.deepEqual(names(scanRepo(w.repo, ctx), 'remote-branch'), []);
    assert.match(explain(w.repo, ctx, 'colleague/x').join('\n'), /result: not mine/);
});

test('a branch with no commits of its own never qualifies, unless a merged PR names it and its tip', () => {
    const w = world();
    sh(w.repo, 'push', '-q', 'origin', 'origin/develop:refs/heads/feat/empty');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), []);
    const tip = sh(w.repo, 'rev-parse', 'origin/develop');
    const pr = (over: Partial<PrInfo>) => () => [{ number: 3, headRefName: 'feat/empty', baseRefName: 'develop', headRefOid: tip, url: 'https://example.com/pull/3', body: '', author: { login: 'me-login' }, ...over }];
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: pr({}) })), 'remote-branch'), ['feat/empty']);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: pr({ headRefName: 'feat/other' }) })), 'remote-branch'), []);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: pr({ headRefOid: '0'.repeat(40) }) })), 'remote-branch'), []);
});

test('a worktree cut with -b x origin/develop is not "gone" and never qualifies', () => {
    const w = world();
    sh(w.repo, 'worktree', 'add', '-q', '-b', 'x', join(w.root, 'x'), 'origin/develop');
    const r = scanRepo(w.repo, ctxFor({ gh: () => [] }));
    assert.deepEqual([r.items, r.review], [[], []]);
    assert.match(r.excluded.map((e) => e.reason).join(), /branch x is not yours/);   // listed as kept, with the reason, never offered
});

test('git and gh errors fail closed: the item is left out and the reason is noted', () => {
    const w = world(); feature(w, 'feat/sq'); mergeInto(w, 'develop', 'feat/sq', true); feature(w, 'feat/ok'); mergeInto(w, 'develop', 'feat/ok');
    const failing = (verb: string) => (repo: string): Git => Object.assign((...a: string[]): CmdResult => {
        const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
        const bad = a.includes(verb);
        return { ok: !bad && r.status === 0, status: bad ? 128 : r.status, out: (r.stdout || '').trim(), err: bad ? 'boom' : (r.stderr || '').trim() };
    }, { repo });
    const cherry = scanRepo(w.repo, ctxFor({ gitFor: failing('cherry'), gh: () => [] }));
    assert.deepEqual([names(cherry, 'remote-branch'), cherry.review], [['feat/ok'], []]);
    assert.match(cherry.notes.join('\n'), /branch feat\/sq skipped: git cherry origin\/develop failed: boom/);
    const log = scanRepo(w.repo, ctxFor({ gitFor: failing('log'), gh: () => [] }));
    assert.deepEqual(log.items, []);
    assert.match(log.notes.join('\n'), /git log --no-merges failed/);
    const gh = scanRepo(w.repo, ctxFor({ gh: () => null }));
    assert.deepEqual(names(gh, 'remote-branch'), ['feat/ok'], 'ancestry needs no gh');
    assert.match(gh.notes.join('\n'), /gh pr list failed/);
});

test('a branch literally named refs/heads/develop is protected, and delete uses the full refspec', () => {
    const w = world(); feature(w, 'feat/x'); mergeInto(w, 'develop', 'feat/x');
    sh(w.repo, 'push', '-q', 'origin', 'origin/develop:refs/heads/refs/heads/develop');
    sh(w.repo, 'fetch', '-q', '--prune', 'origin');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), ['feat/x']);
    sh(w.repo, 'tag', 'feat/x'); sh(w.repo, 'push', '-q', 'origin', 'refs/tags/feat/x'); // a tag of the same name makes a bare `--delete feat/x` ambiguous
    const ctx = ctxFor();
    const [res] = apply([scanRepo(w.repo, ctx).items[0].id], w.container, ctx);
    assert.equal(res.done, true, res.message);
    assert.equal(remoteHas(w, 'feat/x'), false);
    assert.notEqual(sh(w.repo, 'ls-remote', 'origin', 'refs/heads/refs/heads/develop'), '', 'the lookalike branch is untouched');
});

test('apply deletes a qualifying branch and worktree, and re-checks before deleting', () => {
    const w = world(); feature(w, 'feat/ok'); feature(w, 'feat/grew'); feature(w, 'feat/wt');
    for (const b of ['feat/ok', 'feat/grew', 'feat/wt']) mergeInto(w, 'develop', b);
    const wt = join(w.root, 'wt'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/wt');
    const ctx = ctxFor();
    const listed = scanRepo(w.repo, ctx).items;
    const id = (n: string, kind = 'remote-branch') => must(listed.find((i) => i.kind === kind && i.name.endsWith(n))).id;
    sh(w.repo, 'checkout', '-q', 'feat/grew'); commit(w.repo, 'more.txt', 'late\n'); sh(w.repo, 'push', '-q', 'origin', 'feat/grew'); sh(w.repo, 'checkout', '-q', 'main');
    const res = apply([id('feat/ok'), id('feat/grew'), id('/wt', 'worktree')], w.container, ctx);
    assert.deepEqual(res.map((r) => r.done), [true, false, true], JSON.stringify(res));
    assert.match(res[1].message, /refused: no longer qualifies/);
    assert.equal(remoteHas(w, 'feat/ok'), false);
    assert.equal(remoteHas(w, 'feat/grew'), true);
    assert.equal(existsSync(wt), false);
    assert.equal(sh(w.repo, 'branch', '--list', 'feat/wt'), 'feat/wt', 'local branches are never deleted');
});

test('an id is bound to the tip: apply refuses it once the branch has moved, even if it still qualifies', () => {
    const w = world(); feature(w, 'feat/moves'); mergeInto(w, 'develop', 'feat/moves');
    const ctx = ctxFor();
    const [item] = scanRepo(w.repo, ctx).items;
    sh(w.repo, 'checkout', '-q', 'feat/moves'); commit(w.repo, 'late.txt', 'late\n'); sh(w.repo, 'push', '-q', 'origin', 'feat/moves'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/moves');
    assert.equal(scanRepo(w.repo, ctx).items.length, 1, 'still qualifies');
    const [res] = apply([item.id], w.container, ctx);
    assert.equal(res.done, false);
    assert.match(res.message, /tip moved/);
    assert.equal(remoteHas(w, 'feat/moves'), true);
});

test('a remote delete carries a lease on the listed tip: a push after the listing is refused, the next branch still goes', () => {
    const w = world(); feature(w, 'feat/raced'); feature(w, 'feat/calm');
    for (const b of ['feat/raced', 'feat/calm']) mergeInto(w, 'develop', b);
    const items = scanRepo(w.repo, ctxFor()).items;
    const raced = must(items.find((i) => i.name === 'feat/raced')); const calm = must(items.find((i) => i.name === 'feat/calm'));
    assert.equal(raced.tip, sh(w.repo, 'rev-parse', 'refs/remotes/origin/feat/raced'), 'the listed tip is the remote tip');
    sh(w.repo, 'checkout', '-q', 'feat/raced'); commit(w.repo, 'late.txt', 'late\n'); sh(w.repo, 'push', '-q', 'origin', 'feat/raced'); sh(w.repo, 'checkout', '-q', 'main');
    // The re-scan in apply() would already refuse this; call the delete directly to exercise the lease itself.
    const refused = deleteRemoteBranch(w.repo, raced, raced.id);
    assert.equal(refused.done, false);
    assert.match(refused.message, /^refused: feat\/raced moved on origin/);
    assert.equal(remoteHas(w, 'feat/raced'), true, 'the moved branch survives');
    assert.equal(deleteRemoteBranch(w.repo, calm, calm.id).done, true);
    const again = deleteRemoteBranch(w.repo, calm, calm.id);
    assert.equal(again.done, true, 'already gone is the wanted end state, not a refusal');
    assert.match(again.message, /already gone/);
    assert.equal(remoteHas(w, 'feat/calm'), false);
});

test('CLI: lists read-only as JSON through MAESTRO_GH, and --apply needs ids', () => {
    const w = world(); feature(w, 'feat/cli'); mergeInto(w, 'develop', 'feat/cli');
    const env = { PATH: process.env.PATH, HOME: w.root, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GIT_EMAILS: ME, MAESTRO_GH: '/nonexistent/gh', MAESTRO_SWEEP_IDLE_MINUTES: '1' };
    const r = spawnSync(process.execPath, [SCRIPT, '--container', w.container, '--json'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as { items: { name: string }[] }).items.map((i) => i.name), ['feat/cli']);
    assert.equal(remoteHas(w, 'feat/cli'), true);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--container', w.container, '--apply'], { encoding: 'utf8', env }).status, 2);
});

/** A gh stub over `all` ({ number, mergedAt: 'YYYY-MM-DD', ...pr fields }) that honours `merged:A..B` and caps a page at `cap`, as GitHub search does. */
const searchGh = (all: PrInfo[], cap = 1000, calls: string[][] = []): GhJson => (_repo, args) => {
    calls.push(args);
    const [a, b] = args[args.indexOf('--search') + 1].replace('merged:', '').split('..');
    return all.filter((p) => (p.mergedAt as string) >= a && (p.mergedAt as string) <= b).slice(0, cap);
};
const daysAgo = (n: number): string => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

test('merged PRs are read by date window, so a busy repo is not cut off at one page', () => {
    const w = world(); feature(w, 'feat/old'); mergeInto(w, 'develop', 'feat/old', true);
    const tip = sh(w.repo, 'rev-parse', 'origin/feat/old');
    const filler = Array.from({ length: 1500 }, (_, i) => ({ number: 1000 + i, mergedAt: daysAgo(i % 2 ? 30 : 31), headRefName: `x/${i}`, baseRefName: 'develop', headRefOid: 'f'.repeat(40), url: 'u', body: '' }));
    const mine = { number: 5, mergedAt: daysAgo(31), headRefName: 'feat/old', baseRefName: 'develop', headRefOid: tip, url: 'https://example.com/pull/5', body: '' };
    const calls: string[][] = [];
    // the stub lists filler first and caps each page, so a single capped query would never reach PR #5
    const r = scanRepo(w.repo, ctxFor({ gh: searchGh([...filler, mine], 1000, calls) }));
    assert.deepEqual(names(r, 'remote-branch'), ['feat/old']);
    assert.ok(calls.every((a) => a.includes('--search') && a.includes('--state') && a.includes('merged')));
});

test('a PR merged before the look-back window reads as not merged; prDays widens it', () => {
    const w = world(); feature(w, 'feat/old'); mergeInto(w, 'develop', 'feat/old', true);
    const tip = sh(w.repo, 'rev-parse', 'origin/feat/old');
    const pr = [{ number: 5, mergedAt: daysAgo(200), headRefName: 'feat/old', baseRefName: 'develop', headRefOid: tip, url: 'u', body: '' }];
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: searchGh(pr) })), 'remote-branch'), []);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: searchGh(pr), prDays: 400 })), 'remote-branch'), ['feat/old']);
});

test('one failed window fails the whole PR lookup closed', () => {
    const w = world(); feature(w, 'feat/sq'); mergeInto(w, 'develop', 'feat/sq', true);
    let n = 0;
    const r = scanRepo(w.repo, ctxFor({ gh: () => (++n === 3 ? null : []) }));
    assert.deepEqual(r.items, []);
    assert.match(r.notes.join('\n'), /gh pr list failed/);
});

test('a branch cut from a develop that already held a colleague\'s merged work is judged on its own commits', () => {
    const w = world();
    feature(w, 'feat/colleague', { email: 'colleague@example.com' }); mergeInto(w, 'develop', 'feat/colleague');
    sh(w.repo, 'checkout', '-q', '-b', 'feat/mine', 'develop');
    commit(w.repo, 'mine.txt', 'mine\n'); sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/mine'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/mine'); mergeInto(w, 'staging', 'feat/mine');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ twin: ['proj'] })), 'remote-branch'), ['feat/mine']);
    // the same shape with the colleague's commit inside the branch (merged into it, not already in develop) stays foreign
    sh(w.repo, 'checkout', '-q', '-b', 'feat/mixed', 'main'); commit(w.repo, 'm.txt', 'm\n');
    commit(w.repo, 'c.txt', 'c\n', 'colleague@example.com'); sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/mixed'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/mixed'); mergeInto(w, 'staging', 'feat/mixed');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ twin: ['proj'] })), 'remote-branch'), ['feat/mine']);
});

test('--explain prints each rule\'s verdict and agrees with the scan, and writes nothing', () => {
    const w = world(); twins(w, 'fix/x', 'fix/x-staging');
    const prs = [pr(1, 'develop', 'fix/x', tipOf(w, 'fix/x')), pr(2, 'staging', 'fix/x-staging', tipOf(w, 'fix/x-staging'))];
    const ctx = ctxFor({ twin: ['proj'], gh: searchGh(prs), fetch: false });
    const text = explain(w.repo, ctx, 'fix/x').join('\n');
    for (const m of [/PASS every own commit is the user's/, /target develop:\n  FAIL ancestry\n  PASS own merged PR: PR #1/, /target staging:[^]*PASS twin PR: twin PR #2/, /result: CANDIDATE/]) assert.match(text, m);
    assert.match(explain(w.repo, ctxFor({ twin: ['proj'], gh: searchGh([prs[0]]), fetch: false }), 'fix/x').join('\n'), /target staging:[^]*FAIL twin PR[^]*result: not merged into staging/);
    assert.match(explain(w.repo, ctx, 'nope').join('\n'), /not on origin/);
    assert.match(explain(w.repo, ctx, 'develop').join('\n'), /protected branch/);
    assert.equal(remoteHas(w, 'fix/x'), true);
});

const COLLEAGUE = 'colleague@example.com';
/** Commits to an existing pushed branch as `email`, then returns to main. */
const addTo = (w: World, branch: string, file: string, email = ME): void => {
    sh(w.repo, 'checkout', '-q', branch); commit(w.repo, file, `${file}\n`, email);
    sh(w.repo, 'push', '-q', 'origin', branch); sh(w.repo, 'checkout', '-q', 'main');
};
const listed = (w: World, over: Partial<SweepContext> = {}) => names(scanRepo(w.repo, ctxFor(over)), 'remote-branch');

test('ownership counts every round a branch was merged: a colleague commit from an earlier merge stays foreign', () => {
    const w = world();
    feature(w, 'feat/x', { email: COLLEAGUE }); mergeInto(w, 'develop', 'feat/x');
    addTo(w, 'feat/x', 'mine.txt'); mergeInto(w, 'develop', 'feat/x');
    assert.deepEqual(listed(w), []);
    const text = explain(w.repo, ctxFor({ fetch: false, gh: () => [] }), 'feat/x').join('\n');
    assert.match(text, /result: not mine \(1 of 2 commits are by someone else\)/);
});

test('ownership: a branch cut from a colleague\'s branch before that branch merged is not mine (fails closed)', () => {
    const w = world();
    feature(w, 'feat/y', { email: COLLEAGUE });
    sh(w.repo, 'checkout', '-q', '-b', 'feat/x', 'feat/y'); commit(w.repo, 'mine.txt', 'mine\n');
    sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/x'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/y'); mergeInto(w, 'develop', 'feat/x');
    assert.deepEqual(listed(w), []);
});

test('ownership: a merged-twice branch that is all mine, a staging-only merge and an octopus merge still qualify', () => {
    const w = world();
    feature(w, 'feat/twice'); mergeInto(w, 'develop', 'feat/twice');
    addTo(w, 'feat/twice', 'more.txt'); mergeInto(w, 'develop', 'feat/twice');
    feature(w, 'feat/stg'); mergeInto(w, 'staging', 'feat/stg');
    feature(w, 'feat/oct1'); feature(w, 'feat/oct2', { email: COLLEAGUE });
    sh(w.repo, 'checkout', '-q', 'develop');
    sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'merge', '-q', '-m', 'octopus', 'feat/oct1', 'feat/oct2');
    sh(w.repo, 'push', '-q', 'origin', 'develop'); sh(w.repo, 'checkout', '-q', 'main');
    assert.deepEqual(listed(w, { targets: { proj: ['develop'] } }), ['feat/oct1', 'feat/twice']);
    assert.deepEqual(listed(w, { targets: { proj: ['staging'] } }), ['feat/stg']);
});

test('ownership: a cherry-picked colleague commit is foreign', () => {
    const w = world();
    feature(w, 'feat/theirs', { email: COLLEAGUE });
    const picked = sh(w.repo, 'rev-parse', 'origin/feat/theirs');
    sh(w.repo, 'checkout', '-q', '-b', 'feat/cp', 'main'); sh(w.repo, 'cherry-pick', picked);
    sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/cp'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/cp');
    assert.deepEqual(listed(w), [], 'the cherry-pick carries the colleague\'s authorship');
});

test('ownership: a fast-forwarded branch has no commits of its own, so it needs an exact merged PR', () => {
    const w = world();
    feature(w, 'feat/ff'); sh(w.repo, 'push', '-q', 'origin', 'origin/feat/ff:refs/heads/develop');
    sh(w.repo, 'fetch', '-q', 'origin');
    assert.deepEqual(listed(w), []);
    assert.deepEqual(listed(w, { gh: searchGh([pr(9, 'develop', 'feat/ff', tipOf(w, 'feat/ff'))]) }), ['feat/ff']);
    const theirs = { ...pr(9, 'develop', 'feat/ff', tipOf(w, 'feat/ff')), author: { login: 'colleague' } };
    assert.deepEqual(listed(w, { gh: searchGh([theirs]) }), [], 'a PR someone else opened is not evidence of ownership');
    assert.deepEqual(listed(w, { ghLogin: '', gh: searchGh([pr(9, 'develop', 'feat/ff', tipOf(w, 'feat/ff'))]) }), [], 'no gh_login means no PR evidence');
});

test('apply refuses everything when the fetch failed, since the refs may be stale', () => {
    const w = world(); feature(w, 'feat/done'); mergeInto(w, 'develop', 'feat/done');
    sh(w.repo, 'fetch', '-q', 'origin');
    const id = scanRepo(w.repo, ctxFor()).items[0].id;
    sh(w.repo, 'remote', 'set-url', 'origin', join(w.container, 'missing.git'));
    const res = apply([id], w.container, ctxFor());
    assert.match(res[0].message, /refused: git fetch failed/);
});

test('twin evidence belongs to the branch: a colleague\'s x-staging, an earlier-round twin or a moved twin does not count', () => {
    const w = world(); feature(w, 'fix/x'); feature(w, 'fix/x-staging', { email: COLLEAGUE });
    mergeInto(w, 'develop', 'fix/x', true); mergeInto(w, 'staging', 'fix/x-staging', true);
    const own = pr(1, 'develop', 'fix/x', tipOf(w, 'fix/x'));
    const theirs = pr(2, 'staging', 'fix/x-staging', tipOf(w, 'fix/x-staging'));
    assert.deepEqual(kept(w, [own, theirs]), [], 'the twin is a colleague\'s branch');

    const v = world(); twins(v, 'fix/x', 'fix/x-staging');
    const [a, b] = [pr(1, 'develop', 'fix/x', tipOf(v, 'fix/x')), pr(2, 'staging', 'fix/x-staging', tipOf(v, 'fix/x-staging'))];
    assert.deepEqual(kept(v, [a, b]), ['fix/x', 'fix/x-staging'], 'the same shape with my own twin qualifies');
    assert.deepEqual(kept(v, [a, { ...b, mergedAt: daysAgo(5) }]), ['fix/x-staging'], 'the twin merged before x\'s PR is an earlier round; x-staging still has x as its later twin');
    assert.deepEqual(kept(v, [pr(3, 'staging', 'fix/x-develop', '0'.repeat(40)), a, b]), ['fix/x', 'fix/x-staging'], 'a twin PR whose head is not in the repo is passed over, not an error');
    addTo(v, 'fix/x-staging', 'later.txt');
    assert.deepEqual(kept(v, [a, b]), [], 'x-staging moved on after its PR: it no longer vouches for x, and has no exact PR itself');
});

test('protected patterns are globs: release/* and staging/* are never listed, backmerge/* only when configured', () => {
    const w = world();
    sh(w.repo, 'push', '-q', 'origin', '--delete', 'staging'); sh(w.repo, 'branch', '-q', '-D', 'staging'); sh(w.repo, 'fetch', '-q', '--prune', 'origin'); // a staging branch would block staging/<date> refs
    const protectedByDefault = ['release/2026-10-01', 'staging/20251217', 'hotfix/urgent'];
    for (const b of [...protectedByDefault, 'backmerge/staging', 'release/2026/nested', 'feat/release']) { feature(w, b); mergeInto(w, 'develop', b); }
    assert.deepEqual(listed(w), ['backmerge/staging', 'feat/release', 'release/2026/nested'], 'one segment only for *, and backmerge/* is opt-in');
    assert.deepEqual(listed(w, { protectedNames: [...defaultContext().protectedNames, 'backmerge/*', 'release/**'] }), ['feat/release']);
    assert.match(explain(w.repo, ctxFor({ fetch: false }), 'release/2026-10-01').join('\n'), /FAIL protected branch/);
});

test('a protected release branch counts as mainline, so a branch cut from it is judged on its own commits', () => {
    const w = world();
    sh(w.repo, 'checkout', '-q', '-b', 'release/1', 'main'); commit(w.repo, 'r.txt', 'r\n', COLLEAGUE); sh(w.repo, 'push', '-q', '-u', 'origin', 'release/1');
    sh(w.repo, 'checkout', '-q', '-b', 'feat/mine', 'release/1'); commit(w.repo, 'mine.txt', 'mine\n');
    sh(w.repo, 'push', '-q', '-u', 'origin', 'feat/mine'); sh(w.repo, 'checkout', '-q', 'main');
    mergeInto(w, 'develop', 'feat/mine');
    assert.deepEqual(listed(w), ['feat/mine']);
});

test('branchGlob: * stays inside a segment, ** crosses, everything else is literal', () => {
    const m = (g: string, b: string) => branchGlob(g).test(b);
    assert.deepEqual([m('release/*', 'release/1.0'), m('release/*', 'release/a/b'), m('release/**', 'release/a/b'), m('main', 'feat/main'), m('a.b', 'axb'), m('*', 'a/b')], [true, false, true, false, false, false]);
});

// ── sweepWorktrees: what `journal.ts roll` runs ────────────────────────────

const sweep = (w: World, over: Partial<SweepContext> = {}, opts: Parameters<typeof sweepWorktrees>[2] = {}) => sweepWorktrees(w.container, ctxFor({ gh: () => [], ...over }), opts);
const keptReason = (r: { kept: { path: string; reason: string }[] }, path: string): string => must(r.kept.find((k) => k.path === path), `kept ${path}`).reason;
const worktreeList = (w: World) => sh(w.repo, 'worktree', 'list', '--porcelain');

test('sweepWorktrees removes a clean merged worktree, keeps its branch, and a second run is a no-op', () => {
    const w = world(); feature(w, 'feat/done'); mergeInto(w, 'develop', 'feat/done'); mergeInto(w, 'staging', 'feat/done');
    const wt = join(w.root, 'done'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/done');
    const first = sweep(w);
    assert.deepEqual(first.removed.map((x) => x.path), [wt]);
    assert.equal(existsSync(wt), false);
    assert.equal(sh(w.repo, 'branch', '--list', 'feat/done'), 'feat/done', 'the local branch stays');
    const before = worktreeList(w);
    const second = sweep(w);
    assert.deepEqual([second.removed, second.pruned, second.kept], [[], [], []]);
    assert.equal(worktreeList(w), before);
});

test('kept worktrees group by reason, biggest first, and a reason it does not know is other', () => {
    const kept = [['a', 'locked'], ['b', '3 untracked files'], ['c', '7 untracked files'], ['d', 'branch x is pushed but not merged into develop; modified 5 min ago (idle window 60)'], ['e', 'something new']]
        .map(([path, reason]) => ({ repo: 'r', path, reason }));
    assert.deepEqual(keptCounts(kept), [{ label: 'untracked files', count: 2 }, { label: 'locked', count: 1 }, { label: 'not idle yet', count: 1 }, { label: 'other', count: 1 }]);
    const lines = worktreeSweepLines({ removed: [], pruned: [], kept, notes: [] });
    assert.equal(lines.filter((l) => l.startsWith('kept')).length, 4);
    assert.equal(worktreeSweepLines({ removed: [], pruned: [], kept, notes: [] }, false, { verbose: true }).filter((l) => l.startsWith('kept')).length, 5);
});

test('sweepWorktrees stops at the next repo boundary once over its budget and names the repos it skipped', () => {
    const w = world();
    sh(w.root, 'clone', '-q', w.origin, join(w.container, 'other'));
    let t = 0;
    const clock = () => (t += 6000); // each look at the clock costs 6 s
    const over = sweep(w, {}, { budgetSeconds: 10, clock });
    assert.equal(over.skipped.length, 1);
    assert.match(worktreeSweepLines(over).join('\n'), /sweep budget reached: skipped 1 repo\(s\): (proj|other)\./);
    assert.deepEqual(sweep(w, {}, { budgetSeconds: 10 }).skipped, [], 'a real clock is nowhere near 10 s here');
    assert.deepEqual(sweep(w, {}, { clock }).skipped, [], 'no budget means no limit');
});

test('sweepWorktrees keeps a dirty worktree, whether the file is modified or untracked, and says why', () => {
    const w = world(); feature(w, 'feat/mod'); feature(w, 'feat/new');
    for (const b of ['feat/mod', 'feat/new']) { mergeInto(w, 'develop', b); mergeInto(w, 'staging', b); }
    const mod = join(w.root, 'mod'); const fresh = join(w.root, 'fresh');
    sh(w.repo, 'worktree', 'add', '-q', mod, 'feat/mod'); sh(w.repo, 'worktree', 'add', '-q', fresh, 'feat/new');
    writeFileSync(join(mod, 'feat_mod.txt'), 'edited\n');
    writeFileSync(join(fresh, 'scratch.txt'), 'untracked\n');
    const r = sweep(w);
    assert.deepEqual(r.removed, []);
    assert.match(keptReason(r, mod), /uncommitted changes/);
    assert.match(keptReason(r, fresh), /untracked files/);
    assert.deepEqual([existsSync(mod), existsSync(fresh)], [true, true]);
    assert.equal(sh(mod, 'status', '--porcelain'), 'M feat_mod.txt', 'the edit survives');
});

test('sweepWorktrees keeps a worktree with unpushed commits, merged-looking or not', () => {
    const w = world(); feature(w, 'feat/ahead'); feature(w, 'feat/pushed');
    const ahead = join(w.root, 'ahead'); const pushed = join(w.root, 'pushed');
    sh(w.repo, 'worktree', 'add', '-q', ahead, 'feat/ahead'); sh(w.repo, 'worktree', 'add', '-q', pushed, 'feat/pushed');
    commit(ahead, 'local.txt', 'not pushed\n');
    const r = sweep(w);
    assert.deepEqual(r.removed, []);
    assert.match(keptReason(r, ahead), /1 unpushed commit/);
    assert.match(keptReason(r, pushed), /pushed but not merged/);
    assert.deepEqual([existsSync(ahead), existsSync(pushed)], [true, true]);
});

test('sweepWorktrees removes a clean detached worktree on origin, and keeps one holding commits that are not', () => {
    const w = world();
    const clean = join(w.root, 'clean'); const work = join(w.root, 'work');
    sh(w.repo, 'worktree', 'add', '-q', '--detach', clean, 'origin/develop');
    sh(w.repo, 'worktree', 'add', '-q', '--detach', work, 'origin/develop');
    commit(work, 'wip.txt', 'detached work\n');
    const r = sweep(w);
    assert.deepEqual(r.removed.map((x) => x.path), [clean]);
    assert.match(r.removed[0].why, /detached at .* reachable from origin/);
    assert.equal(existsSync(clean), false);
    assert.match(keptReason(r, work), /detached HEAD \w+ holds 1 commit\(s\) not on any origin ref/);
    assert.equal(existsSync(work), true);
});

test('sweepWorktrees keeps a dirty detached worktree', () => {
    const w = world();
    const wt = join(w.root, 'dirty'); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/develop');
    writeFileSync(join(wt, 'base.txt'), 'changed\n');
    const r = sweep(w);
    assert.deepEqual(r.removed, []);
    assert.match(keptReason(r, wt), /uncommitted changes/);
});

test('sweepWorktrees prunes an entry whose directory is gone, and a second run has nothing left to prune', () => {
    const w = world(); feature(w, 'feat/gone'); mergeInto(w, 'develop', 'feat/gone'); mergeInto(w, 'staging', 'feat/gone');
    const wt = join(w.root, 'gone'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/gone');
    rmSync(wt, { recursive: true });
    assert.match(worktreeList(w), /prunable/);
    const first = sweep(w);
    assert.deepEqual(first.pruned.map((x) => x.path), [wt]);
    assert.doesNotMatch(worktreeList(w), /gone/);
    assert.equal(sh(w.repo, 'branch', '--list', 'feat/gone'), 'feat/gone');
    const second = sweep(w);
    assert.deepEqual([second.removed, second.pruned, second.kept], [[], [], []]);
});

test('sweepWorktrees --dry-run changes nothing', () => {
    const w = world(); feature(w, 'feat/dry'); mergeInto(w, 'develop', 'feat/dry'); mergeInto(w, 'staging', 'feat/dry');
    const wt = join(w.root, 'dry'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/dry');
    const gone = join(w.root, 'dry-gone'); sh(w.repo, 'worktree', 'add', '-q', '--detach', gone, 'origin/develop'); rmSync(gone, { recursive: true });
    const r = sweep(w, {}, { dryRun: true });
    assert.deepEqual([r.removed.map((x) => x.path), r.pruned.map((x) => x.path)], [[wt], [gone]]);
    assert.equal(existsSync(wt), true);
    assert.match(worktreeList(w), /dry-gone/);
    assert.deepEqual(r.kept, [], 'a missing directory is listed as pruned, not also as kept');
    assert.match(worktreeSweepLines(r, true).join('\n'), /would remove +\S+dry .*\n.*would prune +\S+dry-gone/);
});

test('sweepWorktrees leaves a locked worktree and a live-claimed repo alone, and does not touch remote branches', () => {
    const w = world(); feature(w, 'feat/lock'); mergeInto(w, 'develop', 'feat/lock'); mergeInto(w, 'staging', 'feat/lock');
    const wt = join(w.root, 'lock'); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/develop');
    sh(w.repo, 'worktree', 'lock', wt);
    assert.match(keptReason(sweep(w), wt), /locked/);
    sh(w.repo, 'worktree', 'unlock', wt);
    const claimed = sweep(w, { claims: new Map([[w.name, { desk: 'Launch' }]]) });
    assert.deepEqual(claimed.removed, []);
    assert.match(keptReason(claimed, wt), /claimed by Launch/);
    assert.equal(remoteHas(w, 'feat/lock'), true, 'a merged remote branch is out of scope');
});

test('sweepWorktrees does not fetch or scan a repo with no linked worktree, and still does for one that has one', () => {
    const w = world();
    sh(w.repo, 'remote', 'set-url', 'origin', join(w.root, 'nowhere.git')); // any fetch now fails and says so
    const none = sweep(w);
    assert.deepEqual([none.removed, none.pruned, none.kept, none.notes], [[], [], [], []], 'a fetch would have left a note');
    const wt = join(w.root, 'linked'); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    assert.match(keptReason(sweep(w), wt), /fetch failed/, 'a repo with a worktree is still fetched');
});

test('a sweep scoped to the merged repo still protects worktrees in use, and never touches another repo', () => {
    const w = world();
    sh(w.root, 'clone', '-q', w.origin, join(w.container, 'other'));
    const inUse = join(w.root, 'in-use'); const dirty = join(w.root, 'dirty'); const elsewhere = join(w.root, 'elsewhere');
    for (const p of [inUse, dirty]) sh(w.repo, 'worktree', 'add', '-q', '--detach', p, 'origin/develop');
    sh(join(w.container, 'other'), 'worktree', 'add', '-q', '--detach', elsewhere, 'origin/develop');
    writeFileSync(join(dirty, 'wip.txt'), 'unsaved\n');
    const scoped = (over = {}) => sweep(w, over, { only: w.name });
    const recent = scoped({ idleMinutes: 60 });
    assert.deepEqual(recent.removed, [], 'just touched: idle guard');
    assert.match(keptReason(recent, inUse), /modified .* min ago/);
    const claimed = scoped({ claims: new Map([[w.name, { desk: 'Launch' }]]) });
    assert.deepEqual(claimed.removed, [], 'live claim guard');
    assert.match(keptReason(claimed, inUse), /claimed by Launch/);
    const last = scoped();
    assert.deepEqual(last.removed.map((x) => x.path), [inUse], 'the clean, idle, unclaimed one goes');
    assert.match(keptReason(last, dirty), /untracked/, 'uncommitted guard');
    assert.equal(existsSync(elsewhere), true, 'another repo is out of scope even though it qualifies');
    assert.ok(![...last.kept, ...last.removed].some((x) => x.repo === 'other'));
});

test('removeWorktree refuses when the worktree changed after the scan, and never forces', () => {
    const w = world();
    const wt = join(w.root, 'late'); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/develop');
    const ctx = ctxFor({ gh: () => [] });
    const [item] = scanRepo(w.repo, ctx).items;
    writeFileSync(join(wt, 'late.txt'), 'arrived after the scan\n');
    assert.match(removeWorktree(w.repo, item).message, /uncommitted, untracked/);
    rmSync(join(wt, 'late.txt'));
    commit(wt, 'late.txt', 'committed after the scan\n');
    assert.match(removeWorktree(w.repo, item).message, /moved since it was scanned/);
    assert.equal(existsSync(wt), true);
});

test('removeWorktree re-checks ignored and hidden-untracked files itself, whatever the repo config says', () => {
    const w = world();
    writeFileSync(join(w.repo, '.gitignore'), 'secret.env\n'); sh(w.repo, 'add', '.gitignore');
    sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'ignore'); sh(w.repo, 'push', '-q', 'origin', 'main');
    sh(w.repo, 'config', 'status.showUntrackedFiles', 'no');
    const wt = join(w.root, 'cfg'); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
    const [item] = scanRepo(w.repo, ctxFor({ gh: () => [] })).items.filter((i) => i.name === wt);
    writeFileSync(join(wt, 'secret.env'), 'kept\n');
    assert.match(removeWorktree(w.repo, item).message, /ignored files/);
    rmSync(join(wt, 'secret.env'));
    writeFileSync(join(wt, 'notes.txt'), 'hidden by config\n');
    assert.match(removeWorktree(w.repo, item).message, /untracked/);
    assert.equal(existsSync(wt), true);
});

test('--apply-worktrees from the command line removes what qualifies and prints kept as counts, or one by one with --verbose', () => {
    const w = world();
    const clean = join(w.root, 'clean'); const work = join(w.root, 'work');
    sh(w.repo, 'worktree', 'add', '-q', '--detach', clean, 'origin/develop');
    sh(w.repo, 'worktree', 'add', '-q', '--detach', work, 'origin/develop');
    writeFileSync(join(work, 'new.txt'), 'x\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--apply-worktrees', '--container', w.container, '--idle-minutes', '0', '--claims-dir', join(w.root, 'none')], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH: 'false' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`removed +${clean}`));
    assert.match(r.stdout, /kept +1  untracked files/);
    assert.doesNotMatch(r.stdout, new RegExp(`kept +${work}`));
    assert.match(r.stdout, /worktrees: 1 removed, 0 pruned, 1 kept\./);
    assert.deepEqual([existsSync(clean), existsSync(work)], [false, true]);
    const v = spawnSync(process.execPath, [SCRIPT, '--apply-worktrees', '--verbose', '--container', w.container, '--idle-minutes', '0', '--claims-dir', join(w.root, 'none')], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH: 'false' } });
    assert.match(v.stdout, new RegExp(`kept +${work} .*untracked`));
});

// ── sweepWorktrees: a failure it cannot decide through is reported in `failed`, never swallowed ──

/** Runs `fn` with a `git` first on PATH that fails any command whose arguments match `pattern`, and runs the real git otherwise. */
function withFailingGit<T>(w: World, pattern: string, fn: () => T): T {
    const bin = join(w.root, 'shim'); mkdirSync(bin, { recursive: true });
    const real = must(process.env.PATH, 'PATH').split(':').map((d) => join(d, 'git')).find((p) => existsSync(p));
    writeFileSync(join(bin, 'git'), `#!/bin/bash\ncase " $* " in *" ${pattern} "*) echo "injected failure" >&2; exit 1;; esac\nexec ${must(real, 'real git')} "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try { return fn(); } finally { process.env.PATH = saved; }
}
const mergedWorktree = (w: World, branch: string): string => {
    feature(w, branch); mergeInto(w, 'develop', branch); mergeInto(w, 'staging', branch);
    const wt = join(w.root, branch.replace('/', '-')); sh(w.repo, 'worktree', 'add', '-q', wt, branch);
    return wt;
};

test('sweepWorktrees reports a scan that stopped on a git error as failed, and decides nothing in that repo', () => {
    const w = world(); const wt = mergedWorktree(w, 'feat/stop');
    const stop = (repo: string): Git => Object.assign((...a: string[]): CmdResult => {
        if (a.includes('for-each-ref')) return { ok: false, status: 128, out: '', err: 'boom' };
        const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
        return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
    }, { repo });
    const out = sweep(w, { gitFor: stop });
    assert.deepEqual(out.failed, ['proj: scan stopped']);
    assert.match(out.notes.join('\n'), /proj: scan stopped: git for-each-ref/);
    assert.deepEqual(out.removed, []);
    assert.equal(existsSync(wt), true, 'nothing was decided, so nothing was removed');
});

test('sweepWorktrees reports a failed prune as failed, and still removes what qualifies', () => {
    const w = world(); const gone = mergedWorktree(w, 'feat/gone2'); const live = mergedWorktree(w, 'feat/live2');
    rmSync(gone, { recursive: true });
    const out = withFailingGit(w, 'worktree prune', () => sweep(w));
    assert.deepEqual(out.failed, ['proj: prune failed']);
    assert.deepEqual(out.pruned, []);
    assert.match(out.notes.join('\n'), /prune skipped: git worktree prune failed/);
    assert.deepEqual(out.removed.map((x) => x.path), [live]);
});

test('sweepWorktrees reports a failed removal as failed and keeps the worktree', () => {
    const w = world(); const wt = mergedWorktree(w, 'feat/stuck');
    const out = withFailingGit(w, 'worktree remove', () => sweep(w));
    assert.deepEqual(out.failed, [`proj: could not remove ${wt}`]);
    assert.deepEqual(out.removed, []);
    assert.match(keptReason(out, wt), /^failed:/);
    assert.equal(existsSync(wt), true);
});

test('sweepWorktrees reports a failed fetch as failed and keeps what it would have removed', () => {
    const w = world(); const wt = mergedWorktree(w, 'feat/stale');
    const out = withFailingGit(w, 'fetch --prune origin', () => sweep(w));
    assert.deepEqual(out.failed, ['proj: git fetch failed']);
    assert.deepEqual(out.removed, []);
    assert.match(keptReason(out, wt), /fetch failed/);
});

/** A clean, detached, idle worktree that qualifies for removal, so only the in-use guard can keep it. */
const qualifying = (w: World, name: string): string => {
    const wt = join(w.root, name); sh(w.repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/develop');
    return wt;
};

test('sweepWorktrees keeps the worktree the process cwd is inside, and removes it once the cwd moves', () => {
    const w = world(); const wt = qualifying(w, 'cwd'); const other = qualifying(w, 'bystander');
    mkdirSync(join(wt, 'sub'));
    const before = process.cwd();
    try {
        process.chdir(join(wt, 'sub'));
        const r = sweep(w);
        assert.match(keptReason(r, wt), /^in use/);
        assert.deepEqual(r.removed.map((x) => x.path), [other], 'only the bystander goes');
        assert.equal(existsSync(wt), true);
    } finally { process.chdir(before); }
    assert.deepEqual(sweep(w).removed.map((x) => x.path), [wt]);
});

test('sweepWorktrees keeps the worktree holding the running script, found through a symlink', () => {
    const w = world(); const wt = qualifying(w, 'script');
    const link = join(w.root, 'link.ts'); symlinkSync(join(wt, 'base.txt'), link);
    const argv1 = process.argv[1];
    try {
        process.argv[1] = link; // the script's own path is a symlink; only its real path is inside the worktree
        const r = sweep(w);
        assert.match(keptReason(r, wt), /^in use/);
        assert.deepEqual(r.removed, []);
    } finally { process.argv[1] = argv1; }
    assert.deepEqual(sweep(w).removed.map((x) => x.path), [wt]);
});

test('sweepWorktrees keeps the checkout the installed loop supervisor runs from, and a worktree that contains it', () => {
    const w = world(); const wt = qualifying(w, 'runtime'); const other = qualifying(w, 'unrelated');
    const plist = join(process.env.MAESTRO_LAUNCH_AGENTS_DIR as string, 'com.jackreichert.the-maestro-loop.plist');
    try {
        writeFileSync(plist, `<dict><key>WorkingDirectory</key>\n  <string>${join(wt, 'base.txt')}</string></dict>`);
        const r = sweep(w);
        assert.match(keptReason(r, wt), /^in use/);
        assert.deepEqual(r.removed.map((x) => x.path), [other]);
        assert.match(worktreeSweepLines(r, false).join('\n'), /1 +in use/);
        assert.match(removeWorktree(w.repo, { id: 'x', name: wt, kind: 'worktree', head: sh(wt, 'rev-parse', 'HEAD'), detached: true }).message, /in use/, 'a direct removal refuses too');
    } finally { rmSync(plist, { force: true }); }
    assert.deepEqual(sweep(w).removed.map((x) => x.path), [wt], 'once the plist is gone the checkout is free');
});
