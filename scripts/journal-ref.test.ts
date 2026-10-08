// Run: node --test scripts/journal-ref.test.ts
// Hermetic: a temp vault and a temp status dir. Never the live ledger.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.MAESTRO_EVENT_DIR = mkdtempSync(join(tmpdir(), 'journal-ref-events-'));

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
const TEMP = tmpdir();

let vault: string;
let statusDir: string;
let files: string;
let cwd: string;

interface Row { id?: string; kind?: string; attaches?: string; refs?: string[]; text?: string; [field: string]: unknown }
interface Run { code: number | null; out: string; err: string }

function run(...args: string[]): Run {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8',
        cwd,
        env: {
            ...process.env,
            VAULT_ROOT: '',
            LEDGER_ROOT: '',
            MAESTRO_STATUS_DIR: statusDir,
            MAESTRO_PROJECTS_DIR: join(vault, 'projects'),
            MAESTRO_CONTAINER_ROOT: '',
            MAESTRO_UPDATE_CHECK: 'off',
            MAESTRO_EVENT_DIR: join(vault, 'Events'),
            MAESTRO_LAUNCH_AGENTS_DIR: join(vault, 'LaunchAgents'),
        },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

const ledgerPath = (): string => join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
const ledgerText = (): string => (existsSync(ledgerPath()) ? readFileSync(ledgerPath(), 'utf8') : '');
const ledger = (): Row[] => ledgerText().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
const idOf = (out: string): string => out.trim().split(/\s+/)[1] ?? '';
const memo = (name: string): string => {
    const path = join(files, name);
    writeFileSync(path, '# note\n');
    return path;
};

function decision(text = 'branch from staging'): string {
    const r = run('log', text, '--kind', 'decision', ...MARK);
    assert.equal(r.code, 0, r.err);
    return idOf(r.out);
}

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'journal-ref-'));
    statusDir = mkdtempSync(join(tmpdir(), 'journal-ref-status-'));
    files = mkdtempSync(join(tmpdir(), 'journal-ref-files-'));
    cwd = mkdtempSync(join(tmpdir(), 'journal-ref-cwd-'));
    for (const dir of [vault, statusDir, files, cwd]) assert.ok(dir.startsWith(TEMP), dir);
});

afterEach(() => {
    for (const dir of [vault, statusDir, files, cwd]) rmSync(dir, { recursive: true, force: true });
});

test('ref appends refs onto an existing decision and a later reader sees them', () => {
    const id = decision();
    const before = ledgerText();
    const a = memo('a.md');
    const b = memo('b.md');
    const r = run('ref', id, '--ref', a, '--ref', b, ...MARK);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^ref  ${id}  `));
    const rows = ledger();
    assert.equal(rows.length, 2);
    assert.equal(`${JSON.stringify(rows[0])}\n`, before, 'the decision row is not rewritten');
    assert.equal(rows[1]?.kind, 'ref');
    assert.equal(rows[1]?.attaches, id);
    assert.deepEqual(rows[1]?.refs, [a, b]);
    const again = run('ref', id, '--ref', a, ...MARK);
    assert.equal(again.code, 0, again.err);
    const after = ledger();
    assert.equal(after.length, 3, 'a second ref appends; it does not rewrite');
    assert.equal(`${JSON.stringify(after[0])}\n`, before);
    const triage = JSON.parse(run('triage', '--json').out) as { items: { id?: string; ref: string | null }[]; blockers: { id?: string }[] };
    assert.equal(triage.items.find((i) => i.id === id)?.ref, a);
    assert.equal(triage.blockers.some((b) => b.id === id), false);
});

test('ref refuses a missing id and writes nothing', () => {
    const omitted = run('ref', '--ref', memo('a.md'), ...MARK);
    assert.equal(omitted.code, 1);
    assert.match(omitted.err, /Usage: journal\.ts ref/);
    assert.equal(ledgerText(), '');

    const id = decision();
    const before = ledgerText();
    const unknown = run('ref', 'nope00', '--ref', memo('b.md'), ...MARK);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /No row with id "nope00"/);
    assert.equal(ledgerText(), before);
});

test('ref refuses an id that is not a decision and writes nothing', () => {
    const noted = run('log', 'a later note', ...MARK);
    assert.equal(noted.code, 0, noted.err);
    const id = idOf(noted.out);
    const before = ledgerText();
    const r = run('ref', id, '--ref', memo('a.md'), ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /only a decision can take a ref/);
    assert.equal(ledgerText(), before);
});

test('ref refuses when any --ref file does not exist and writes nothing', () => {
    const id = decision();
    const before = ledgerText();
    const missing = run('ref', id, '--ref', join(files, 'gone.md'), ...MARK);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not an existing file/);
    assert.equal(ledgerText(), before);

    const oneBad = run('ref', id, '--ref', memo('a.md'), '--ref', join(files, 'also-gone.md'), ...MARK);
    assert.equal(oneBad.code, 1);
    assert.match(oneBad.err, /also-gone\.md is not an existing file/);
    assert.equal(ledgerText(), before);
});
