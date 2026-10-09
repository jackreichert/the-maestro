// Run: node --test scripts/journal-brief.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPrompt, briefPaths, briefText, libraryBlock } from './lib/journal/brief.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
const FILLED = '## Standing brief block, filled\n\n- `<user git emails>` → `dev@example.com`\n- `<tracker key example>` → FAKE-1\n';

let vault: string;
let outDir: string;
let config: string;
let cwd: string;

/** Runs journal.ts against a throwaway ledger; `cfg` is the one config file it may read ('' for none). */
function run(args: string[], cfg: string = config, script: string = SCRIPT) {
    const r = spawnSync(process.execPath, [script, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd,
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: cfg, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const rows = (): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idOf = (out: string): string => out.trim().split(/\s+/)[1] as string;
const lock = (repo: string) => join(vault, 'Projects', 'test-proj', 'Claims', `${repo}.lock`);
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
    assert.match(readFileSync(briefPaths(outDir, id).brief, 'utf8'), /Read-only: no claim is held/);

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

test('libraryBlock: a failing lookup is an error, a missing tool is said so, never silently empty', () => {
    const ok = libraryBlock(() => ({ status: 0, stdout: 'Library pages for this task:\n- a.md\n', stderr: '' }), 'x');
    assert.deepEqual(ok, { ok: true, text: 'Library pages for this task:\n- a.md' });
    const failed = libraryBlock(() => ({ status: 2, stdout: '', stderr: 'no index\nmore' }), 'x');
    assert.equal(failed.ok, false);
    assert.match(failed.ok ? '' : failed.error, /exit 2\): no index/);
    const absent = libraryBlock(null, 'no repo named');
    assert.match(absent.ok ? absent.text : '', /none \(no repo named\)/);
});

test('briefText states the cap and the report path once each, and the repo role', () => {
    const t = briefText({ id: 'ab12', text: 'obj', repo: 'r', library: 'lib', standing: 'rules', writer: true, reportPath: '/tmp/report-ab12.md' });
    assert.equal(t.split('/tmp/report-ab12.md').length - 1, 1);
    assert.match(t, /You hold the repo claim/);
});

/** A scripts dir whose journal.ts, pr-open.ts and brief-block.ts are the real ones and whose library-brief.ts is the given stub. */
function shelfWith(libraryStub: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'brief-shelf-'));
    for (const f of ['journal.ts', 'pr-open.ts', 'brief-block.ts']) symlinkSync(new URL(`./${f}`, import.meta.url).pathname, join(dir, f));
    writeFileSync(join(dir, 'library-brief.ts'), libraryStub);
    return join(dir, 'journal.ts');
}

test('the library block comes from library-brief.ts when it is installed, asked for the item\'s repo and words', () => {
    const shelf = shelfWith("console.log('LIB repo=' + process.argv[process.argv.indexOf('--repo') + 1] + ' words=' + process.argv.at(-1));");
    const id = start('fix the widget', '--repo', 'repo-a', '--stream', 'Alpha');
    const r = run(['brief', id, '--out-dir', outDir, ...MARK], config, shelf);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(briefPaths(outDir, id).brief, 'utf8'), /LIB repo=repo-a words=fix the widget/);
});

test('a failing library-brief.ts refuses the brief before the claim', () => {
    const shelf = shelfWith("console.error('index missing'); process.exit(2);");
    const id = start('fix the widget', '--repo', 'repo-a', '--stream', 'Alpha');
    const before = rows().length;
    const r = run(['brief', id, '--out-dir', outDir, ...MARK], config, shelf);
    assert.equal(r.code, 1);
    assert.match(r.err, /library-brief failed \(exit 2\): index missing/);
    assert.equal(existsSync(lock('repo-a')), false);
    assert.equal(existsSync(briefPaths(outDir, id).brief), false);
    assert.equal(rows().length, before);
});
