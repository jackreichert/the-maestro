// Run: node --test scripts/journal-recover.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryFromFlags, recoverPrompt } from './lib/journal/recover.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = ((): string => {
    const dir = mkdtempSync(join(tmpdir(), 'recover-shelf-'));
    for (const f of ['journal.ts', 'pr-open.ts', 'brief-block.ts']) symlinkSync(new URL(`./${f}`, import.meta.url).pathname, join(dir, f));
    return join(dir, 'journal.ts');
})();
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

let vault: string;
let cwd: string;
let config: string;

function run(args: string[]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd,
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: config, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const rows = (): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idOf = (out: string): string => out.trim().split(/\s+/)[1] as string;
const start = (text: string, ...extra: string[]) => idOf(run(['start', text, ...extra, ...MARK]).out);

/** A real git worktree with one commit on a named branch. */
function liveWorktree(branch: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'recover-wt-'));
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', branch);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'feat: first commit');
    writeFileSync(join(dir, 'dirty.txt'), 'x\n');
    return dir;
}

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'recover-test-'));
    cwd = mkdtempSync(join(tmpdir(), 'recover-cwd-'));
    config = join(mkdtempSync(join(tmpdir(), 'recover-cfg-')), 'config.md');
    writeFileSync(config, '## Standing brief block, filled\n\n- `<user git emails>` → `dev@example.com`\n- `<tracker key example>` → FAKE-1\n');
});

test('a row with a live worktree recovers with its status, commits, branch and next step', () => {
    const wt = liveWorktree('feat/FAKE-1-thing');
    const id = start('build the thing', '--repo', 'repo-a', '--worktree', wt, '--next', 'write the tests');
    const wip = rows().find((r) => r.id === id);
    assert.equal(wip?.worktree, wt);
    assert.equal(wip?.branch, 'feat/FAKE-1-thing', 'the branch is worked out from the worktree');
    const r = run(['recover', id]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Re-dispatch of ledger item/);
    assert.match(r.out, /Next step recorded: write the tests/);
    assert.match(r.out, /feat\/FAKE-1-thing/);
    assert.match(r.out, /\?\? dirty\.txt/);
    assert.match(r.out, /feat: first commit/);
});

test('a row whose worktree is gone says so and points at the branch', () => {
    const id = start('build the thing', '--repo', 'repo-a', '--worktree', '/nonexistent/wt-gone', '--branch', 'feat/FAKE-2-gone');
    const r = run(['recover', id]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /The worktree is missing: \/nonexistent\/wt-gone/);
    assert.match(r.out, /feat\/FAKE-2-gone/);
    assert.match(r.out, /none recorded/);
});

test('an old row with none of the new fields still recovers and still lists', () => {
    const id = start('an old row');
    const wip = rows().find((r) => r.id === id) as Record<string, unknown>;
    for (const k of ['worktree', 'branch', 'nextStep']) assert.ok(!(k in wip), `${k} is absent`);
    const r = run(['recover', id]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /not recorded \(an older row\)/);
    assert.equal(run(['status']).code, 0);
});

test('next records the step, the latest wins, and a closed item refuses', () => {
    const id = start('step item', '--repo', 'repo-a');
    assert.equal(run(['next', id, 'first step', ...MARK]).code, 0);
    assert.equal(run(['next', id, 'second step', '--branch', 'feat/FAKE-3-x', ...MARK]).code, 0);
    const out = run(['recover', id]).out;
    assert.match(out, /Next step recorded: second step/);
    assert.match(out, /Branch: feat\/FAKE-3-x/);
    assert.equal(run(['done', id, ...MARK]).code, 0);
    assert.equal(run(['next', id, 'late', ...MARK]).code, 1);
    assert.equal(run(['recover', id]).code, 1);
    assert.equal(run(['verify']).code, 0, 'next rows verify');
});

test('start on an item already in flight takes the flags as a next row', () => {
    const id = start('already going');
    const r = run(['start', id, '--next', 'resume here', '--branch', 'feat/FAKE-4-y', ...MARK]);
    assert.equal(r.code, 0, r.err);
    assert.match(run(['recover', id]).out, /Next step recorded: resume here/);
});

test('brief records the worktree and branch it was given, and recover shows the brief path', () => {
    const out = mkdtempSync(join(tmpdir(), 'recover-out-'));
    const wt = liveWorktree('feat/FAKE-5-brief');
    const id = start('brief me', '--repo', 'repo-a', '--stream', 'Alpha');
    const b = run(['brief', id, '--out-dir', out, '--worktree', wt, '--next', 'start with the tests', ...MARK]);
    assert.equal(b.code, 0, b.err);
    const row = rows().find((r) => r.kind === 'brief');
    assert.equal(row?.worktree, wt);
    assert.equal(row?.branch, 'feat/FAKE-5-brief');
    const r = run(['recover', id]).out;
    assert.match(r, new RegExp(`Original brief: ${out}/brief-${id}\\.md`));
    assert.match(r, /Next step recorded: start with the tests/);
});

test('recoveryFromFlags resolves a relative worktree and only probes when no branch is given', () => {
    assert.deepEqual(recoveryFromFlags({}), {});
    assert.deepEqual(recoveryFromFlags({ branch: 'b', next: 'n' }, () => assert.fail('no probe')), { branch: 'b', nextStep: 'n' });
    assert.equal(recoveryFromFlags({ worktree: 'rel/wt' }, () => 'probed').branch, 'probed');
    assert.ok(recoveryFromFlags({ worktree: 'rel/wt' }, () => undefined).worktree?.startsWith('/'));
});

test('recoverPrompt reads the injected git state', () => {
    const wt = mkdtempSync(join(tmpdir(), 'recover-fake-'));
    mkdirSync(wt, { recursive: true });
    const text = recoverPrompt({ item: { id: 'ab12', text: 't', worktree: wt, branch: 'b' }, library: 'LIB', state: () => ({ status: 'S', log: 'L' }) });
    assert.match(text, /S\nLast commits:\nL/);
    assert.match(text, /\nLIB\n/);
});

test('recover leaves the worktree .git/index untouched (read-only, no optional locks)', () => {
    const wt = liveWorktree('feat/FAKE-1-ro');
    const id = start('read only', '--repo', 'repo-a', '--worktree', wt, '--next', 'x');
    const index = join(wt, '.git', 'index');
    // A stat-dirty tracked file makes plain `git status` refresh and rewrite the index.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(wt, 'a.txt'), old, old);
    utimesSync(index, old, old);
    const before = { mtime: statSync(index).mtimeMs, bytes: readFileSync(index) };
    const r = run(['recover', id]);
    assert.equal(r.code, 0, r.err);
    assert.equal(statSync(index).mtimeMs, before.mtime, 'index mtime changed');
    assert.ok(readFileSync(index).equals(before.bytes), 'index contents changed');
});
