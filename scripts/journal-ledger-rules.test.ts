// Run: node --test scripts/journal-ledger-rules.test.ts
// The ledger writing rules, enforced by the writer: each rule has a test that rejects the bad form.
// Hermetic: a temp vault, status dir and memory dir. Never the live ledger.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

let vault: string;
let statusDir: string;
let memory: string;

interface Row { id?: string; kind?: string; text?: string; verified?: string; unverified?: boolean; closes?: string }
interface Run { code: number | null; out: string; err: string }

function run(args: string[], env: Record<string, string> = {}): Run {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--tickets-vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: {
            ...process.env, VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_STATUS_DIR: statusDir, MAESTRO_PROJECTS_DIR: join(vault, 'projects'), MAESTRO_CONTAINER_ROOT: '',
            MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_LAUNCH_AGENTS_DIR: join(vault, 'LaunchAgents'), MAESTRO_MEMORY_DIR: memory, ...env,
        },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

const ledgerPath = (): string => join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
const ledger = (): Row[] => (existsSync(ledgerPath()) ? readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
const idOf = (out: string): string => out.split(/\s+/)[1] ?? '';

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'ledger-rules-'));
    statusDir = mkdtempSync(join(tmpdir(), 'ledger-rules-status-'));
    memory = mkdtempSync(join(tmpdir(), 'ledger-rules-memory-'));
});

afterEach(() => {
    for (const dir of [vault, statusDir, memory]) rmSync(dir, { recursive: true, force: true });
});

test('done with neither --verify nor --unverified is refused, names both flags, and writes no closing row', () => {
    const id = idOf(run(['start', 'ship the widget', ...MARK]).out);
    const r = run(['done', id, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /done needs --verify "<the command or url/);
    assert.match(r.err, /--unverified/);
    assert.equal(ledger().filter((x) => x.kind === 'done').length, 0);
});

test('done refuses --verify and --unverified together, and an empty --verify', () => {
    const id = idOf(run(['start', 'ship the widget', ...MARK]).out);
    const both = run(['done', id, '--verify', 'gh pr view 1', '--unverified', ...MARK]);
    assert.equal(both.code, 1);
    assert.match(both.err, /not both/);
    const empty = run(['done', id, '--verify', ...MARK]);
    assert.equal(empty.code, 1);
    assert.match(empty.err, /--verify needs a value|done needs --verify/);
    assert.equal(ledger().filter((x) => x.kind === 'done').length, 0);
});

test('done --verify records what was checked; done --unverified records the flag', () => {
    const a = idOf(run(['start', 'first', ...MARK]).out);
    const b = idOf(run(['start', 'second', ...MARK]).out);
    assert.equal(run(['done', a, '--verify', 'gh pr view 12 --json state', ...MARK]).code, 0);
    assert.equal(run(['done', b, '--unverified', ...MARK]).code, 0);
    const rows = ledger().filter((x) => x.kind === 'done');
    assert.equal(rows.find((x) => x.closes === a)?.verified, 'gh pr view 12 --json state');
    assert.equal(rows.find((x) => x.closes === b)?.unverified, true);
});

test('drop and resolve take no proof flag', () => {
    const id = idOf(run(['start', 'abandon me', ...MARK]).out);
    const r = run(['drop', id, '--verify', 'x', ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--verify and --unverified are for done/);
});
