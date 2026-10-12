// Run: node --test scripts/journal-decide.test.ts
// Hermetic: a temp vault, status dir and memory dir. Never the live ledger or DECISIONS.md.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.MAESTRO_EVENT_DIR = mkdtempSync(join(tmpdir(), 'journal-decide-events-'));

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

let vault: string;
let statusDir: string;
let memory: string;

interface Row { id?: string; kind?: string; refs?: string[]; text?: string; pending?: boolean }
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
const decisionsPath = (): string => join(vault, 'Projects', 'test-proj', 'DECISIONS.md');

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'journal-decide-'));
    statusDir = mkdtempSync(join(tmpdir(), 'journal-decide-status-'));
    memory = mkdtempSync(join(tmpdir(), 'journal-decide-memory-'));
});

afterEach(() => {
    for (const dir of [vault, statusDir, memory]) rmSync(dir, { recursive: true, force: true });
});

test('decide with the default project scope adds one DECISIONS.md entry and one ledger row naming the file', () => {
    const r = run(['decide', 'Ship the Podium on Fridays', '--why', 'reviews land Thursday', '--rejected', 'Mondays', '--consequence', 'freeze on Thursday night', ...MARK]);
    assert.equal(r.code, 0, r.err);
    const md = readFileSync(decisionsPath(), 'utf8');
    assert.match(md, /## \d{4}-\d{2}-\d{2}: Ship the Podium on Fridays/);
    assert.match(md, /\*\*Rationale:\*\* reviews land Thursday/);
    assert.match(md, /\*\*Rejected alternatives:\*\* Mondays/);
    assert.match(md, /\*\*Consequence:\*\* freeze on Thursday night/);
    const rows = ledger().filter((x) => x.kind === 'decision');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.refs, [decisionsPath()]);
    assert.notEqual(rows[0]?.pending, true, 'a recorded decision is not an open ask');
    const again = run(['decide', 'Ship the Podium on Fridays', '--why', 'reviews land Thursday', '--rejected', 'Mondays', '--consequence', 'freeze on Thursday night', ...MARK]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already recorded/);
    assert.equal(ledger().length, 1);
    assert.equal((readFileSync(decisionsPath(), 'utf8').match(/^## /gm) ?? []).length, 1);
});

test('decide --scope working-rule writes a memory file and one index line; the same topic updates', () => {
    const first = run(['decide', 'Reply to bot threads only', '--why', 'people resolve their own', '--scope', 'working-rule', '--topic', 'bot-threads', ...MARK]);
    assert.equal(first.code, 0, first.err);
    const second = run(['decide', 'Reply to bot threads and nits', '--why', 'nits are cheap', '--scope', 'working-rule', '--topic', 'bot-threads', ...MARK]);
    assert.equal(second.code, 0, second.err);
    const index = readFileSync(join(memory, 'MEMORY.md'), 'utf8').trim().split('\n');
    assert.equal(index.length, 1);
    assert.match(index[0] as string, /nits are cheap/);
    assert.match(readFileSync(join(memory, 'bot-threads.md'), 'utf8'), /Reply to bot threads and nits/);
    assert.deepEqual(ledger().map((x) => x.refs), [[join(memory, 'bot-threads.md')], [join(memory, 'bot-threads.md')]]);
    assert.equal(existsSync(decisionsPath()), false);
});

test('a missing --why, a secret shape, a missing --model and an unwritable file each leave no ledger row and no file', () => {
    const noWhy = run(['decide', 'Do the thing', ...MARK]);
    assert.equal(noWhy.code, 1);
    assert.match(noWhy.err, /--why is required/);

    const key = `sk-${'a1B2c3D4'.repeat(5)}`;
    const secret = run(['decide', 'Rotate the key', '--why', `old one was ${key}`, ...MARK]);
    assert.equal(secret.code, 1);
    assert.ok(!secret.err.includes(key), 'the refusal never echoes the value');

    const noModel = run(['decide', 'Do the thing', '--why', 'because']);
    assert.equal(noModel.code, 1);

    const blocker = join(memory, 'a-file');
    writeFileSync(blocker, 'x');
    const unwritable = run(['decide', 'Do the thing', '--why', 'because', '--scope', 'working-rule', ...MARK], { MAESTRO_MEMORY_DIR: join(blocker, 'mem') });
    assert.equal(unwritable.code, 1);
    assert.match(unwritable.err, /nothing recorded/);

    const noDir = run(['decide', 'Do the thing', '--why', 'because', '--scope', 'working-rule', ...MARK], { MAESTRO_MEMORY_DIR: '' });
    assert.equal(noDir.code, 1);
    assert.match(noDir.err, /memory_dir/);

    assert.deepEqual(ledger(), []);
    assert.equal(existsSync(decisionsPath()), false);
});

test('a reversal needs --new and then prints the closest earlier decision', () => {
    run(['decide', 'Set autocompact to 50 percent for long sessions', '--why', 'earlier compaction', ...MARK]);
    const r = run(['decide', 'Set autocompact to 70 percent for long sessions', '--why', 'too many handoffs', '--new', ...MARK]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Closest earlier decision \(.*\): .*50 percent/);
});

test('decide --repo names the DECISIONS.md project while the row goes to the --project ledger', () => {
    const r = run(['decide', 'Name tickets by task', '--why', 'readable footers', '--repo', 'other-repo', ...MARK]);
    assert.equal(r.code, 0, r.err);
    const target = join(vault, 'Projects', 'other-repo', 'DECISIONS.md');
    assert.match(readFileSync(target, 'utf8'), /Name tickets by task/);
    assert.equal(existsSync(decisionsPath()), false);
    const rows = ledger().filter((x) => x.kind === 'decision');
    assert.equal(rows.length, 1, 'the row is in the container ledger');
    assert.deepEqual(rows[0]?.refs, [target]);
    const bad = run(['decide', 'Escape', '--why', 'because', '--repo', '../x', ...MARK]);
    assert.equal(bad.code, 1);
});

test('a reworded decision on a recorded topic is refused before anything is written, unless --new', () => {
    run(['decide', 'Open release pull requests as drafts only', '--why', 'Samwise undrafts', ...MARK]);
    const before = readFileSync(decisionsPath(), 'utf8');
    const reworded = run(['decide', 'Release pull requests are opened as drafts only', '--why', 'a different reason', ...MARK]);
    assert.equal(reworded.code, 1);
    assert.match(reworded.err, /already recorded.*--new/s);
    assert.equal(readFileSync(decisionsPath(), 'utf8'), before, 'no second entry');
    assert.equal(ledger().filter((x) => x.kind === 'decision').length, 1, 'no second row');
    const forced = run(['decide', 'Release pull requests are opened as drafts only', '--why', 'a different reason', '--new', ...MARK]);
    assert.equal(forced.code, 0, forced.err);
    assert.equal((readFileSync(decisionsPath(), 'utf8').match(/^## /gm) ?? []).length, 2);
});

test('decide --msg puts the scan marker on the row so the decision scan skips that message', () => {
    const marker = '[msg 2026-10-11T10:00:00.000Z 1a2b3c]';
    const r = run(['decide', 'Ship the Podium on Fridays', '--why', 'reviews land Thursday', '--msg', marker, ...MARK]);
    assert.equal(r.code, 0, r.err);
    assert.ok(ledger().some((x) => x.kind === 'decision' && x.text?.includes(marker)));
    assert.equal(run(['decide', 'Ship it', '--why', 'because', '--msg', 'nonsense', ...MARK]).code, 1);
});
