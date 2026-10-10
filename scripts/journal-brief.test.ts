// Run: node --test scripts/journal-brief.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPrompt, briefPaths, briefText, libraryBlock } from './lib/journal/brief.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
/** A scripts dir whose journal.ts, pr-open.ts and brief-block.ts are the real ones; library-brief.ts is the given stub, or absent when none is given. */
const REAL = Symbol('real library-brief.ts');
function shelfWith(libraryStub?: string | typeof REAL): string {
    const dir = mkdtempSync(join(tmpdir(), 'brief-shelf-'));
    for (const f of ['journal.ts', 'pr-open.ts', 'brief-block.ts']) symlinkSync(new URL(`./${f}`, import.meta.url).pathname, join(dir, f));
    if (libraryStub === REAL) symlinkSync(new URL('./library-brief.ts', import.meta.url).pathname, join(dir, 'library-brief.ts'));
    else if (libraryStub !== undefined) writeFileSync(join(dir, 'library-brief.ts'), libraryStub);
    return join(dir, 'journal.ts');
}
// Most tests are about claims and grants, not the library: they run on a shelf with no library-brief.ts. The real one is exercised in the "fails open" tests below.
const SCRIPT = shelfWith();
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
const FILLED = '## Standing brief block, filled\n\n- `<user git emails>` → `dev@example.com`\n- `<tracker key example>` → FAKE-1\n';

let vault: string;
let outDir: string;
let config: string;
let cwd: string;

/** Runs journal.ts against a throwaway ledger; `cfg` is the one config file it may read ('' for none). */
function run(args: string[], cfg: string = config, script: string = SCRIPT, env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [script, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd,
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: cfg, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const rows = (): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idOf = (out: string): string => out.trim().split(/\s+/)[1] as string;
const lock = (repo: string) => join(vault, 'Projects', 'test-proj', 'Claims', `${repo}.lock`);
/** Removes the rows of one kind from the ledger file (a run that died before writing them). */
function rowsDrop(kind: string): void {
    const f = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter((l) => l && JSON.parse(l).kind !== kind).map((l) => l + '\n').join(''));
}
const start = (text: string, ...extra: string[]) => idOf(run(['start', text, ...extra, ...MARK]).out);

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'brief-test-'));
    outDir = mkdtempSync(join(tmpdir(), 'brief-out-'));
    cwd = mkdtempSync(join(tmpdir(), 'brief-cwd-'));
    config = join(mkdtempSync(join(tmpdir(), 'brief-cfg-')), 'config.md');
    writeFileSync(config, FILLED);
});

test('brief writes the file, the brief row and the repo claim, and prints a one-line prompt', () => {
    const id = start('fix the widget', '--repo', 'repo-a', '--stream', 'Alpha');
    const r = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 0, r.err);
    const { brief, report } = briefPaths(outDir, id);
    const text = readFileSync(brief, 'utf8');
    assert.match(text, /## Objective\n\nfix the widget/);
    assert.match(text, /Standing rules \(hard limits\):/);
    assert.ok(text.includes('dev@example.com') && !/<user git emails>/.test(text), 'slots are filled');
    assert.match(text, /under 150 words plus that path/);
    assert.ok(text.includes(report));
    assert.match(text, /Library pages for this task: none \(library-brief\.ts is not installed/);
    assert.ok(r.out.includes(`Agent prompt: ${agentPrompt(brief, report)}`));
    assert.equal(JSON.parse(readFileSync(lock('repo-a'), 'utf8')).desk, 'Alpha');
    const row = rows().find((x) => x.kind === 'brief');
    assert.equal(row?.briefs, id);
    assert.equal(row?.brief, brief);
    assert.equal(row?.report, report);
    assert.equal(rows().filter((x) => x.kind === 'claim').length, 1);
    assert.equal(run(['verify']).code, 0, 'a brief row refers to an item that exists');
});

test('a queued item is promoted to in flight when it is briefed', () => {
    const id = idOf(run(['queue', 'queued job', '--repo', 'repo-a', '--stream', 'Alpha', ...MARK]).out);
    assert.equal(run(['brief', id, '--out-dir', outDir, ...MARK]).code, 0);
    assert.equal(rows().filter((x) => x.kind === 'promote' && x.promotes === id).length, 1);
    assert.doesNotMatch(run(['status']).out, /Queued/);
});

test('a second item for a claimed repo is refused, naming the holder, and writes nothing', () => {
    const a = start('first job', '--repo', 'repo-a', '--stream', 'Alpha');
    const b = start('second job', '--repo', 'repo-a', '--stream', 'Beta');
    assert.equal(run(['brief', a, '--out-dir', outDir, ...MARK]).code, 0);
    const before = rows().length;
    const r = run(['brief', b, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /repo-a is already claimed by desk Alpha/);
    assert.equal(existsSync(briefPaths(outDir, b).brief), false);
    assert.equal(rows().length, before);
    assert.equal(JSON.parse(readFileSync(lock('repo-a'), 'utf8')).desk, 'Alpha');
});

test('briefing the same item again as the same holder is a rerun: same file, no new rows', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    assert.equal(run(['brief', id, '--out-dir', outDir, ...MARK]).code, 0);
    const before = rows().length;
    const again = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already written for this holder/);
    assert.match(again.out, /Agent prompt:/);
    assert.equal(rows().length, before);
});

test('a desk that claimed the repo itself, as desks.md says, can brief its own item', () => {
    const id = start('job', '--repo', 'repo-c', '--stream', 'Cee');
    assert.equal(run(['claim', 'repo-c', '--desk', 'Cee', ...MARK]).code, 0);
    const r = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /the desk's own claim, kept/);
    assert.equal(rows().filter((x) => x.kind === 'claim').length, 1, 'no second claim row');
    assert.equal(existsSync(briefPaths(outDir, id).brief), true);
});

test('another desk is still refused a repo the first desk claimed by hand', () => {
    const id = start('job', '--repo', 'repo-c', '--stream', 'Dee');
    run(['claim', 'repo-c', '--desk', 'Cee', ...MARK]);
    const r = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /repo-c is already claimed by desk Cee/);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Claims', 'briefs', `${id}.lock`)), false, 'the item grant is dropped on refusal');
});

test('a second holder briefing an item already briefed is refused, naming the first', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    assert.equal(run(['brief', id, '--as', 'window-1', '--out-dir', outDir, ...MARK]).code, 0);
    const before = rows().length;
    const r = run(['brief', id, '--as', 'window-2', '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /already briefed for a writer by window-1/);
    assert.equal(rows().length, before);
    assert.equal(run(['brief', id, '--as', 'window-1', '--out-dir', outDir, ...MARK]).code, 0, 'the first holder may rerun');
});

test('four concurrent briefs of one item by four holders: exactly one wins, one brief row, one promote', async () => {
    const id = idOf(run(['queue', 'same job', '--repo', 'repo-b', '--stream', 'Bee', ...MARK]).out);
    const results = await Promise.all([1, 2, 3, 4].map((k) => new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, [SCRIPT, 'brief', id, '--as', `w${k}`, '--out-dir', outDir, ...MARK, '--vault', vault, '--project', 'test-proj'], {
            env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: config, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') }, stdio: ['ignore', 'ignore', 'pipe'], cwd,
        });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => resolve({ code, err }));
    })));
    assert.equal(results.filter((r) => r.code === 0).length, 1, results.map((r) => r.err).join('\n'));
    for (const r of results.filter((x) => x.code !== 0)) assert.match(r.err, /already briefed for a writer by w\d/);
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 1);
    assert.equal(rows().filter((x) => x.kind === 'promote').length, 1);
    assert.equal(rows().filter((x) => x.kind === 'claim').length, 1);
});

test('release drops the item grants for that repo, so another holder can brief afterwards', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    run(['brief', id, '--as', 'window-1', '--out-dir', outDir, ...MARK]);
    assert.equal(run(['release', 'repo-a', '--desk', 'Alpha', ...MARK]).code, 0);
    assert.equal(run(['brief', id, '--as', 'window-2', '--out-dir', outDir, ...MARK]).code, 0);
});

test('an unfillable standing block refuses before any claim, file or row', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    const before = rows().length;
    const r = run(['brief', id, '--out-dir', outDir, ...MARK], '');
    assert.equal(r.code, 1);
    assert.match(r.err, /standing block could not be built/);
    assert.equal(existsSync(briefPaths(outDir, id).brief), false);
    assert.equal(existsSync(lock('repo-a')), false);
    assert.equal(rows().length, before);
});

test('--read-only takes no claim; a closed item cannot be briefed; a missing --desk is refused', () => {
    const id = start('look around', '--repo', 'repo-a', '--stream', 'Alpha');
    const ro = run(['brief', id, '--read-only', '--out-dir', outDir, ...MARK]);
    assert.equal(ro.code, 0, ro.err);
    assert.match(ro.out, /claim  none \(read-only\)/);
    assert.equal(existsSync(lock('repo-a')), false);
    assert.match(readFileSync(briefPaths(outDir, id, false).brief, 'utf8'), /Read-only: no claim is held/);

    const noStream = start('no desk', '--repo', 'repo-b');
    const r = run(['brief', noStream, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--desk/);
    assert.equal(existsSync(lock('repo-b')), false);

    run(['done', id, ...MARK]);
    assert.equal(run(['brief', id, '--out-dir', outDir, ...MARK]).code, 1);
});

test('--details-file is carried into the brief, and an unreadable one refuses before the claim', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    const details = join(outDir, 'details.txt');
    writeFileSync(details, 'Anchor: scripts/x.ts:10');
    assert.equal(run(['brief', id, '--details-file', details, '--out-dir', outDir, ...MARK]).code, 0);
    assert.match(readFileSync(briefPaths(outDir, id).brief, 'utf8'), /## Task details\n\nAnchor: scripts\/x\.ts:10/);
    const other = start('other', '--repo', 'repo-c', '--stream', 'Alpha');
    const bad = run(['brief', other, '--details-file', join(outDir, 'missing.txt'), '--out-dir', outDir, ...MARK]);
    assert.equal(bad.code, 1);
    assert.equal(existsSync(lock('repo-c')), false);
});

test('libraryBlock: a failing lookup says so in one line, a missing tool is said so, never silently empty', () => {
    const ok = libraryBlock(() => ({ status: 0, stdout: 'Library pages for this task:\n- a.md\n', stderr: '' }), 'x');
    assert.equal(ok, 'Library pages for this task:\n- a.md');
    const failed = libraryBlock(() => ({ status: 2, stdout: '', stderr: 'no index\nmore' }), 'x');
    assert.match(failed, /^Library pages for this task: unavailable \(library-brief failed, exit 2: no index\)/);
    assert.equal(failed.includes('\n'), false);
    const absent = libraryBlock(null, 'no repo named');
    assert.match(absent, /none \(no repo named\)/);
});

test('briefText states the cap and the report path once each, and the repo role', () => {
    const t = briefText({ id: 'ab12', text: 'obj', repo: 'r', library: 'lib', standing: 'rules', writer: true, reportPath: '/tmp/report-ab12.md' });
    assert.equal(t.split('/tmp/report-ab12.md').length - 1, 1);
    assert.match(t, /You hold the repo claim/);
});

test('the library block comes from library-brief.ts when it is installed, asked for the item\'s repo and words', () => {
    const shelf = shelfWith("console.log('LIB repo=' + process.argv[process.argv.indexOf('--repo') + 1] + ' words=' + process.argv.at(-1));");
    const id = start('fix the widget', '--repo', 'repo-a', '--stream', 'Alpha');
    const r = run(['brief', id, '--out-dir', outDir, ...MARK], config, shelf);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(briefPaths(outDir, id).brief, 'utf8'), /LIB repo=repo-a words=fix the widget/);
});

test('a failing library-brief.ts does not stop the brief: one unavailable line, claim and file still written', () => {
    const shelf = shelfWith("console.error('index missing'); process.exit(2);");
    const id = start('fix the widget', '--repo', 'repo-a', '--stream', 'Alpha');
    const r = run(['brief', id, '--out-dir', outDir, ...MARK], config, shelf);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(briefPaths(outDir, id).brief, 'utf8'), /Library pages for this task: unavailable \(library-brief failed, exit 2: index missing\)/);
    assert.equal(existsSync(lock('repo-a')), true);
});

/** Runs the real library-brief.ts inside `journal.ts brief` and returns the brief text; it must exit 0 whatever the library state. */
function briefWithRealLibrary(text: string, env: Record<string, string>): string {
    const id = start(text, '--repo', 'repo-a', '--stream', 'Alpha');
    const r = run(['brief', id, '--out-dir', outDir, ...MARK], config, shelfWith(REAL), { MAESTRO_STATUS_DIR: mkdtempSync(join(tmpdir(), 'brief-status-')), ...env });
    assert.equal(r.code, 0, r.err);
    const body = readFileSync(briefPaths(outDir, id).brief, 'utf8');
    assert.equal((body.match(/Library pages for this task: unavailable[^\n]*/g) ?? []).length, 1, 'one line');
    return body;
}

test('fails open: the real library-brief.ts with VAULT_ROOT unset still lets the brief go out', () => {
    assert.match(briefWithRealLibrary('fix the widget', {}), /unavailable \(library-brief failed, exit 2: library-brief: no vault/);
});

test('fails open: the real library-brief.ts on a vault with no Projects folder for the repo', () => {
    const tickets = mkdtempSync(join(tmpdir(), 'brief-tickets-'));
    mkdirSync(join(tickets, 'Projects', 'other-repo'), { recursive: true });
    assert.match(briefWithRealLibrary('fix the widget', { VAULT_ROOT: tickets }), /unavailable \(library-brief failed, exit 2: library-brief: the lookup failed: No project "repo-a"/);
});

test('fails open: the real library-brief.ts with task text that has no words', () => {
    const tickets = mkdtempSync(join(tmpdir(), 'brief-tickets-'));
    mkdirSync(join(tickets, 'Projects', 'repo-a'), { recursive: true });
    assert.match(briefWithRealLibrary('?? !!', { VAULT_ROOT: tickets }), /unavailable \(library-brief failed, exit 2: Usage: library-brief\.ts/);
});

const grantPath = (id: string) => join(vault, 'Projects', 'test-proj', 'Claims', 'briefs', `${id}.lock`);
/** A grant left by a run that died: the repo, desk and holder it named, and a pid that is not running. */
function plantOrphanGrant(id: string, repo: string, holder: string): void {
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Claims', 'briefs'), { recursive: true });
    writeFileSync(grantPath(id), JSON.stringify({ id, repo, desk: 'Alpha', holder, pid: 2 ** 22 + 12345, host: hostname(), time: new Date().toISOString() }));
}

test('a rerun after a run that died with grant and claim but no rows writes the missing rows', () => {
    const id = idOf(run(['queue', 'job', '--repo', 'repo-a', '--stream', 'Alpha', ...MARK]).out);
    // What a killed run leaves: the grant, the repo claim (why names the item), no file, no rows.
    plantOrphanGrant(id, 'repo-a', 'Alpha');
    assert.equal(run(['claim', 'repo-a', '--desk', 'Alpha', '--why', `brief ${id}`, ...MARK]).code, 0);
    rowsDrop('claim');
    const r = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 0, r.err);
    assert.equal(rows().filter((x) => x.kind === 'brief' && x.briefs === id).length, 1);
    assert.equal(rows().filter((x) => x.kind === 'promote' && x.promotes === id).length, 1);
    assert.equal(rows().filter((x) => x.kind === 'claim').length, 1);
    assert.doesNotMatch(run(['status']).out, /Queued/);
    assert.equal(run(['verify']).code, 0);
});

test('a failed ledger write rolls the grant and claim back, so the rerun starts clean', () => {
    const id = idOf(run(['queue', 'job', '--repo', 'repo-a', '--stream', 'Alpha', ...MARK]).out);
    const ledgerFile = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    chmodSync(ledgerFile, 0o444);
    const failed = run(['brief', id, '--out-dir', outDir, ...MARK]);
    chmodSync(ledgerFile, 0o644);
    assert.equal(failed.code, 1);
    assert.equal(existsSync(lock('repo-a')), false);
    assert.equal(existsSync(grantPath(id)), false);
    assert.equal(run(['brief', id, '--out-dir', outDir, ...MARK]).code, 0);
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 1);
});

test('an orphan grant (dead run, no rows, no repo claim) is reclaimed by another holder, and release clears it', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    plantOrphanGrant(id, 'repo-a', 'ghost');
    const r = run(['brief', id, '--as', 'window-2', '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 0, r.err);
    const other = start('job two', '--repo', 'repo-b', '--stream', 'Alpha');
    plantOrphanGrant(other, 'repo-b', 'ghost');
    const rel = run(['release', 'repo-b', '--force', ...MARK]);
    assert.equal(rel.code, 0, rel.err);
    assert.equal(existsSync(grantPath(other)), false);
});

test('a live grant is not an orphan: another holder is still refused', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    assert.equal(run(['brief', id, '--as', 'w1', '--out-dir', outDir, ...MARK]).code, 0);
    assert.equal(run(['brief', id, '--as', 'w2', '--out-dir', outDir, ...MARK]).code, 1);
});

test('two writer briefs on one repo are refused even when the desk took the claim by hand', () => {
    const a = start('first', '--repo', 'repo-g', '--stream', 'Ggg');
    const b = start('second', '--repo', 'repo-g', '--stream', 'Ggg');
    assert.equal(run(['claim', 'repo-g', '--desk', 'Ggg', ...MARK]).code, 0);
    assert.equal(run(['brief', a, '--out-dir', outDir, ...MARK]).code, 0);
    const r = run(['brief', b, '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`already has a writer brief for item ${a}`));
    assert.equal(existsSync(briefPaths(outDir, b).brief), false);
    assert.equal(existsSync(grantPath(b)), false);
});

/** Starts one brief run without waiting, so several overlap. */
const spawnBrief = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, 'brief', ...args, '--out-dir', outDir, ...MARK, '--vault', vault, '--project', 'test-proj'], {
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: config, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'], cwd,
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
});

test('a writer brief then a read-only brief use separate files; the read-only one claims nothing', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    assert.equal(run(['brief', id, '--out-dir', outDir, ...MARK]).code, 0);
    const ro = run(['brief', id, '--read-only', '--out-dir', outDir, ...MARK]);
    assert.equal(ro.code, 0, ro.err);
    const writerText = readFileSync(briefPaths(outDir, id).brief, 'utf8');
    const roText = readFileSync(briefPaths(outDir, id, false).brief, 'utf8');
    assert.match(writerText, /You hold the repo claim/);
    assert.match(roText, /Read-only: no claim is held/);
    assert.doesNotMatch(roText, /one writer/);
    assert.notEqual(briefPaths(outDir, id).report, briefPaths(outDir, id, false).report);
});

test('a read-only brief then a writer brief: the writer gets its own file, claim row and brief row', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    assert.equal(run(['brief', id, '--read-only', '--out-dir', outDir, ...MARK]).code, 0);
    const w = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(w.code, 0, w.err);
    assert.match(readFileSync(briefPaths(outDir, id).brief, 'utf8'), /You hold the repo claim/);
    assert.equal(rows().filter((x) => x.kind === 'claim').length, 1);
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 2);
    assert.equal(existsSync(lock('repo-a')), true);
});

test('two holders racing to reclaim a dead run\'s grant: exactly one wins, the other is refused', async () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    plantOrphanGrant(id, 'repo-a', 'ghost');
    const slow = { MAESTRO_TEST_RECLAIM_DELAY_MS: '600' };
    const results = await Promise.all([spawnBrief([id, '--as', 'w1'], slow), spawnBrief([id, '--as', 'w2'], slow)]);
    assert.equal(results.filter((r) => r.code === 0).length, 1, results.map((r) => r.err).join('\n'));
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 1);
    const grant = JSON.parse(readFileSync(grantPath(id), 'utf8'));
    assert.match(grant.holder, /^w[12]$/, 'the surviving grant is the winner\'s');
});

test('concurrent runs by one holder write the rows once', async () => {
    const id = idOf(run(['queue', 'job', '--repo', 'repo-a', '--stream', 'Alpha', ...MARK]).out);
    await Promise.all([1, 2, 3, 4].map(() => spawnBrief([id, '--as', 'same'])));
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 1);
    assert.equal(rows().filter((x) => x.kind === 'promote').length, 1);
    assert.equal(run(['verify']).code, 0);
});

test('a reclaim lock left by a dead run is never broken: briefs are refused naming it, and release clears it', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    plantOrphanGrant(id, 'repo-a', 'ghost');
    writeFileSync(join(vault, 'Projects', 'test-proj', 'Claims', 'briefs', `${id}.reclaim.lock`), JSON.stringify({ repo: 'repo-a', pid: 2 ** 22 + 777, host: hostname(), time: new Date().toISOString() }));
    const before = rows().length;
    const r = run(['brief', id, '--as', 'w1', '--out-dir', outDir, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /being reclaimed by another run \(pid \d+/);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Claims', 'briefs', `${id}.reclaim.lock`)), true, 'the lock is left in place');
    assert.equal(existsSync(grantPath(id)), true, 'the grant is not touched');
    assert.equal(rows().length, before);
    assert.equal(run(['release', 'repo-a', '--force', ...MARK]).code, 0);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Claims', 'briefs', `${id}.reclaim.lock`)), false);
    assert.equal(run(['brief', id, '--as', 'w1', '--out-dir', outDir, ...MARK]).code, 0);
});

test('two runs meeting a dead reclaim lock both refuse; neither deletes the other\'s grant', async () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    plantOrphanGrant(id, 'repo-a', 'ghost');
    writeFileSync(join(vault, 'Projects', 'test-proj', 'Claims', 'briefs', `${id}.reclaim.lock`), JSON.stringify({ repo: 'repo-a', pid: 2 ** 22 + 778, host: hostname(), time: new Date().toISOString() }));
    const slow = { MAESTRO_TEST_RECLAIM_DELAY_MS: '400' };
    const results = await Promise.all([spawnBrief([id, '--as', 'w1'], slow), spawnBrief([id, '--as', 'w2'], slow)]);
    assert.deepEqual(results.map((r) => r.code), [1, 1]);
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 0);
});

test('a re-brief after release takes a new claim and writes its claim row', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    assert.equal(run(['brief', id, '--out-dir', outDir, ...MARK]).code, 0);
    assert.equal(run(['release', 'repo-a', '--desk', 'Alpha', ...MARK]).code, 0);
    const again = run(['brief', id, '--out-dir', outDir, ...MARK]);
    assert.equal(again.code, 0, again.err);
    assert.doesNotMatch(again.out, /already written|already held/);
    const kinds = rows().map((x) => x.kind).filter((k) => ['claim', 'released', 'brief'].includes(k as string));
    assert.deepEqual(kinds, ['claim', 'brief', 'released', 'claim']);
    assert.equal(existsSync(lock('repo-a')), true);
});

test('a non-numeric reclaim delay is ignored, not waited on forever', () => {
    const id = start('job', '--repo', 'repo-a', '--stream', 'Alpha');
    plantOrphanGrant(id, 'repo-a', 'ghost');
    const r = spawnSync(process.execPath, [SCRIPT, 'brief', id, '--as', 'w1', '--out-dir', outDir, ...MARK, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd, timeout: 20000,
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: config, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_TEST_RECLAIM_DELAY_MS: 'abc' },
    });
    assert.equal(r.status, 0, r.stderr);
});

test('a brief that takes the repo while a release is mid-way does not lose its grant: no second writer on the repo', async () => {
    const a = start('first', '--repo', 'repo-a', '--stream', 'Alpha');
    const b = start('second', '--repo', 'repo-a', '--stream', 'Beta');
    const c = start('third', '--repo', 'repo-a', '--stream', 'Beta');
    assert.equal(run(['brief', a, '--out-dir', outDir, ...MARK]).code, 0);
    // The release removes the claim, then pauses before it clears grants: the gap another desk can step into.
    const releasing = new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, [SCRIPT, 'release', 'repo-a', '--desk', 'Alpha', ...MARK, '--vault', vault, '--project', 'test-proj'], {
            env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: config, MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_TEST_RELEASE_PAUSE_MS: '3000' }, stdio: ['ignore', 'ignore', 'pipe'], cwd,
        });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => resolve({ code, err }));
    });
    for (let i = 0; i < 100 && existsSync(lock('repo-a')); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.equal(existsSync(lock('repo-a')), false, 'the release reached its pause');
    const inGap = run(['brief', b, '--out-dir', outDir, ...MARK]);
    assert.equal((await releasing).code, 0);
    // If Beta was briefed in the gap its grant must survive the release; if it was refused, nothing of it may linger. Either way a third item on the repo is refused.
    if (inGap.code === 0) assert.equal(existsSync(grantPath(b)), true, 'the release did not delete the other desk\'s live grant');
    else assert.equal(existsSync(grantPath(b)), false);
    const third = inGap.code === 0 ? run(['brief', c, '--out-dir', outDir, ...MARK]) : (run(['brief', b, '--out-dir', outDir, ...MARK]), run(['brief', c, '--out-dir', outDir, ...MARK]));
    assert.equal(third.code, 1, third.err);
    assert.match(third.err, /(already has a writer brief for item|already claimed by)/);
});
