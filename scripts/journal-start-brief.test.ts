// Run: node --test scripts/journal-start-brief.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefTextProblem, saveBrief } from './lib/journal/brief-link.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
let vault: string;
let cwd: string;

function run(args: string[], input?: string) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd, input,
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_WINDOW: 'w1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const rows = (): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const briefsFolder = () => join(vault, 'Projects', 'test-proj', 'Journal', 'Briefs');

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'start-brief-'));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'start-brief-cwd-')));
});

test('start --brief links an existing file with a brief row, and prime and start-here show it for the in-flight row', () => {
    const file = join(cwd, 'my-brief.md');
    writeFileSync(file, '# Brief\n\nDo the thing.\n');
    const r = run(['start', 'do the thing', '--brief', file, ...MARK]);
    assert.equal(r.code, 0, r.err);
    const wip = rows().find((x) => x.kind === 'wip');
    const link = rows().find((x) => x.kind === 'brief');
    assert.equal(link?.briefs, wip?.id);
    const stored = join(briefsFolder(), readdirSync(briefsFolder())[0] as string);
    assert.equal(link?.brief, stored, 'the file is copied into the Briefs folder, so the link outlives the original');
    assert.equal(readFileSync(stored, 'utf8'), '# Brief\n\nDo the thing.\n');
    assert.match(run(['prime']).out, new RegExp(`${wip?.id} do the thing \\[brief: .*Briefs/`));
    assert.match(run(['start-here']).out, new RegExp(`brief: ${stored}`));
    assert.equal(JSON.parse(run(['start-here', '--json']).out).inFlight[0].brief, stored);
    assert.equal(run(['verify']).code, 0);
});

test('a relative --brief path is resolved against the working directory', () => {
    writeFileSync(join(cwd, 'rel.md'), 'brief text\n');
    assert.equal(run(['start', 'rel', '--brief', 'rel.md', ...MARK]).code, 0);
    assert.equal(readFileSync(rows().find((x) => x.kind === 'brief')?.brief as string, 'utf8'), 'brief text\n');
});

test('--brief-file - saves standard input under the ledger Briefs folder and links it', () => {
    const r = run(['start', 'from stdin', '--brief-file', '-', ...MARK], '# Brief\n\nPrompt text for an agent.\n');
    assert.equal(r.code, 0, r.err);
    const saved = readdirSync(briefsFolder());
    assert.equal(saved.length, 1);
    assert.match(saved[0] as string, /^\d{4}-\d{2}-\d{2}-.+-from-stdin\.md$/);
    assert.equal(readFileSync(join(briefsFolder(), saved[0] as string), 'utf8'), '# Brief\n\nPrompt text for an agent.\n');
    assert.equal(rows().find((x) => x.kind === 'brief')?.brief, join(briefsFolder(), saved[0] as string));
});

test('a missing file, an empty brief and a brief holding a secret each refuse and write nothing', () => {
    const missing = run(['start', 'a', '--brief', join(cwd, 'nope.md'), ...MARK]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no brief file at/);
    const empty = run(['start', 'b', '--brief-file', '-', ...MARK], '  \n');
    assert.equal(empty.code, 1);
    assert.match(empty.err, /the brief is empty/);
    const secret = run(['start', 'c', '--brief-file', '-', ...MARK], 'use key AKIAIOSFODNN7EXAMPLE to deploy\n');
    assert.equal(secret.code, 1);
    assert.match(secret.err, /holds a secret/);
    assert.ok(!secret.err.includes('AKIAIOSFODNN7EXAMPLE'), 'the matched text is never printed');
    assert.ok(!existsSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl')) || rows().length === 0, 'nothing was written');
});

test('a directory, an oversize file, oversize stdin and patient identifiers each refuse', () => {
    const dir = run(['start', 'd', '--brief', cwd, ...MARK]);
    assert.equal(dir.code, 1);
    assert.match(dir.err, /is a directory/);
    writeFileSync(join(cwd, 'big.md'), 'x '.repeat(200 * 1024));
    assert.match(run(['start', 'e', '--brief', join(cwd, 'big.md'), ...MARK]).err, /over 256 KB/);
    assert.match(run(['start', 'f', '--brief-file', '-', ...MARK], 'word '.repeat(60 * 1024)).err, /over 256 KB/);
    const phi = run(['start', 'g', '--brief-file', '-', ...MARK], 'Patient SSN 123-45-6789 needs a visit\n');
    assert.equal(phi.code, 1);
    assert.match(phi.err, /patient data \(ssn\)/);
    assert.ok(!phi.err.includes('123-45-6789'));
    assert.ok(!existsSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl')) || rows().length === 0, 'nothing was written');
});

test('starting a queued item with --brief promotes it and links the brief once; a rerun is idempotent', () => {
    const file = join(cwd, 'q.md');
    writeFileSync(file, 'queued brief\n');
    const queued = run(['queue', 'queued job', '--stream', 'none', ...MARK]);
    const id = queued.out.trim().split(/\s+/)[1] as string;
    assert.equal(run(['start', id, '--brief', file, ...MARK]).code, 0);
    const again = run(['start', id, '--brief', file, ...MARK]);
    assert.match(again.out, /already linked/);
    assert.equal(rows().filter((x) => x.kind === 'brief').length, 1);
});

test('briefTextProblem and saveBrief never overwrite and reuse an identical file', () => {
    assert.equal(briefTextProblem('fine'), null);
    assert.match(briefTextProblem('') ?? '', /empty/);
    const dir = mkdtempSync(join(tmpdir(), 'save-brief-'));
    const a = saveBrief(dir, 'one\n', { day: '2026-10-15', title: 'Same title' });
    const same = saveBrief(dir, 'one\n', { day: '2026-10-15', title: 'Same title' });
    const other = saveBrief(dir, 'two\n', { day: '2026-10-15', title: 'Same title' });
    assert.equal(a, same);
    assert.notEqual(a, other);
    assert.equal(readFileSync(a, 'utf8'), 'one\n');
});
