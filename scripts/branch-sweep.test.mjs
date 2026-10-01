// Run: node --test scripts/branch-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic: never read the user's config file (see local-config.mjs).
process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./branch-sweep.mjs', import.meta.url).pathname;
const { scanRepo, apply, defaultContext } = await import('./branch-sweep.mjs');

const ME = 'me@example.com';
const sh = (repo, ...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};
const commit = (repo, file, text, email = ME) => {
    writeFileSync(join(repo, file), text);
    sh(repo, 'add', file);
    sh(repo, '-c', `user.email=${email}`, '-c', 'user.name=T', 'commit', '-q', '-m', `edit ${file}`);
};

/** A container holding `name`, a clone of a bare origin that has main, develop and staging at one commit. */
function world(name = 'proj') {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
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
function feature(w, branch, { email = ME, file = `${branch.replace(/\W/g, '_')}.txt` } = {}) {
    sh(w.repo, 'checkout', '-q', '-b', branch, 'main');
    commit(w.repo, file, `${branch}\n`, email);
    sh(w.repo, 'push', '-q', '-u', 'origin', branch);
    sh(w.repo, 'checkout', '-q', 'main');
}
const mergeInto = (w, target, branch, squash = false) => {
    sh(w.repo, 'checkout', '-q', target);
    if (squash) { sh(w.repo, 'merge', '--squash', branch); sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'commit', '-q', '-m', 'squash'); }
    else sh(w.repo, '-c', `user.email=${ME}`, '-c', 'user.name=T', 'merge', '-q', '--no-ff', '-m', 'merge', branch);
    sh(w.repo, 'push', '-q', 'origin', target);
    sh(w.repo, 'checkout', '-q', 'main');
};
const ctxFor = (over = {}) => defaultContext({ emails: [ME], twin: [], idleMinutes: 0, claims: new Map(), gh: () => null, ...over });
const names = (r, kind) => r.items.filter((i) => i.kind === kind).map((i) => i.name);
const remoteHas = (w, branch) => sh(w.repo, 'ls-remote', '--heads', 'origin', branch) !== '';

test('merged into develop and staging qualifies in a twin-flow repo', () => {
    const w = world(); feature(w, 'feat/a');
    mergeInto(w, 'develop', 'feat/a'); mergeInto(w, 'staging', 'feat/a');
    const r = scanRepo(w.repo, ctxFor({ twin: ['proj'] }));
    assert.deepEqual(names(r, 'remote-branch'), ['feat/a']);
    assert.match(r.items[0].why, /develop \(ancestry\) and staging \(ancestry\)/);
});

test('merged into develop only does not qualify in a twin-flow repo, but does elsewhere', () => {
    const w = world(); feature(w, 'feat/a'); mergeInto(w, 'develop', 'feat/a');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ twin: ['proj'] })), 'remote-branch'), []);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), ['feat/a']);
});

test('a squash merge qualifies through cherry equivalence', () => {
    const w = world(); feature(w, 'feat/sq'); mergeInto(w, 'develop', 'feat/sq', true);
    assert.notEqual(spawnSync('git', ['-C', w.repo, 'merge-base', '--is-ancestor', 'origin/feat/sq', 'origin/develop']).status, 0, 'not an ancestor');
    const r = scanRepo(w.repo, ctxFor());
    assert.deepEqual(names(r, 'remote-branch'), ['feat/sq']);
    assert.match(r.items[0].why, /develop \(cherry\)/);
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

test('a merged PR counts only when its head is the branch tip; twin found by link', () => {
    const w = world(); feature(w, 'feat/pr'); mergeInto(w, 'develop', 'feat/pr');
    const tip = sh(w.repo, 'rev-parse', 'origin/feat/pr');
    const gh = (head, view = {}) => (_repo, args) => (args[1] === 'list'
        ? [{ number: 7, headRefName: 'feat/pr', baseRefName: 'develop', headRefOid: head, url: 'https://example.com/pull/7', body: 'twin: #8' }]
        : { number: 8, state: 'MERGED', baseRefName: 'staging', headRefName: view.headRefName ?? 'feat/pr', headRefOid: view.headRefOid ?? head, url: 'https://example.com/pull/8' });
    const ok = scanRepo(w.repo, ctxFor({ twin: ['proj'], gh: gh(tip) }));
    assert.deepEqual(names(ok, 'remote-branch'), ['feat/pr']);
    assert.match(ok.items[0].why, /staging \(PR #8\)/);
    assert.deepEqual(ok.items[0].prs, ['https://example.com/pull/8']);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ twin: ['proj'], gh: gh('0'.repeat(40)) })), 'remote-branch'), []);
});

test('a body that only mentions another PR ("follow-up to #40") is not twin evidence', () => {
    const w = world(); feature(w, 'feat/pr'); mergeInto(w, 'develop', 'feat/pr');
    const tip = sh(w.repo, 'rev-parse', 'origin/feat/pr');
    const gh = (view) => (_repo, args) => (args[1] === 'list'
        ? [{ number: 7, headRefName: 'feat/pr', baseRefName: 'develop', headRefOid: tip, url: 'u', body: 'follow-up to #40' }]
        : { number: 40, state: 'MERGED', baseRefName: 'staging', url: 'u40', ...view });
    const kept = (view) => names(scanRepo(w.repo, ctxFor({ twin: ['proj'], gh: gh(view) })), 'remote-branch');
    assert.deepEqual(kept({ headRefName: 'feat/other', headRefOid: 'a'.repeat(40) }), [], 'different head ref');
    assert.deepEqual(kept({ headRefName: 'feat/pr', headRefOid: 'a'.repeat(40) }), [], 'same name, unrelated head');
    assert.deepEqual(kept({ headRefName: 'feat/pr', headRefOid: tip }), ['feat/pr']);
});

test('a clean worktree on a merged branch qualifies; a dirty one is kept and reported', () => {
    const w = world(); feature(w, 'feat/clean'); feature(w, 'feat/dirty'); feature(w, 'feat/loose');
    for (const b of ['feat/clean', 'feat/dirty', 'feat/loose']) { mergeInto(w, 'develop', b); sh(w.repo, 'worktree', 'add', '-q', join(w.root, b.replace('/', '-')), b); }
    writeFileSync(join(w.root, 'feat-dirty', 'feat_dirty.txt'), 'changed\n');
    writeFileSync(join(w.root, 'feat-loose', 'scratch.txt'), 'x\n');
    const r = scanRepo(w.repo, ctxFor());
    assert.deepEqual(names(r, 'worktree').map((p) => p.split('/').pop()), ['feat-clean']);
    assert.match(r.excluded.find((e) => e.name.endsWith('feat-dirty')).reason, /uncommitted changes/);
    assert.match(r.excluded.find((e) => e.name.endsWith('feat-loose')).reason, /1 untracked files/);
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

test('a branch with no commits of its own never qualifies, unless a merged PR names it and its tip', () => {
    const w = world();
    sh(w.repo, 'push', '-q', 'origin', 'origin/develop:refs/heads/feat/empty');
    assert.deepEqual(names(scanRepo(w.repo, ctxFor()), 'remote-branch'), []);
    const tip = sh(w.repo, 'rev-parse', 'origin/develop');
    const pr = (over) => () => [{ number: 3, headRefName: 'feat/empty', baseRefName: 'develop', headRefOid: tip, url: 'https://example.com/pull/3', body: '', ...over }];
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: pr({}) })), 'remote-branch'), ['feat/empty']);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: pr({ headRefName: 'feat/other' }) })), 'remote-branch'), []);
    assert.deepEqual(names(scanRepo(w.repo, ctxFor({ gh: pr({ headRefOid: '0'.repeat(40) }) })), 'remote-branch'), []);
});

test('a worktree cut with -b x origin/develop is not "gone" and never qualifies', () => {
    const w = world();
    sh(w.repo, 'worktree', 'add', '-q', '-b', 'x', join(w.root, 'x'), 'origin/develop');
    const r = scanRepo(w.repo, ctxFor());
    assert.deepEqual([r.items, r.excluded], [[], []]);
});

test('apply deletes a qualifying branch and worktree, and re-checks before deleting', () => {
    const w = world(); feature(w, 'feat/ok'); feature(w, 'feat/grew'); feature(w, 'feat/wt');
    for (const b of ['feat/ok', 'feat/grew', 'feat/wt']) mergeInto(w, 'develop', b);
    const wt = join(w.root, 'wt'); sh(w.repo, 'worktree', 'add', '-q', wt, 'feat/wt');
    const ctx = ctxFor();
    const listed = scanRepo(w.repo, ctx).items;
    const id = (n, kind = 'remote-branch') => listed.find((i) => i.kind === kind && i.name.endsWith(n)).id;
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

test('CLI: lists read-only as JSON through MAESTRO_GH, and --apply needs ids', () => {
    const w = world(); feature(w, 'feat/cli'); mergeInto(w, 'develop', 'feat/cli');
    const env = { PATH: process.env.PATH, HOME: w.root, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GIT_EMAILS: ME, MAESTRO_GH: '/nonexistent/gh', MAESTRO_SWEEP_IDLE_MINUTES: '1' };
    const r = spawnSync(process.execPath, [SCRIPT, '--container', w.container, '--json'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).items.map((i) => i.name), ['feat/cli']);
    assert.equal(remoteHas(w, 'feat/cli'), true);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--container', w.container, '--apply'], { encoding: 'utf8', env }).status, 2);
});
