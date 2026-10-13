// Run: node --test scripts/journal-closing.test.ts
// Hermetic: a temp vault, status dir and memory dir. Never the live ledger or DECISIONS.md.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foldLeases, liveLease } from './lib/journal/leases.ts';
import type { LedgerRow } from './lib/ledger-core.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.MAESTRO_EVENT_DIR = mkdtempSync(join(tmpdir(), 'journal-closing-events-'));

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

let vault: string;
let statusDir: string;
let memory: string;

interface Row { id?: string; kind?: string; refs?: string[]; text?: string; pending?: boolean; closes?: string }
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

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'journal-closing-'));
    statusDir = mkdtempSync(join(tmpdir(), 'journal-closing-status-'));
    memory = mkdtempSync(join(tmpdir(), 'journal-closing-memory-'));
});

afterEach(() => {
    for (const dir of [vault, statusDir, memory]) rmSync(dir, { recursive: true, force: true });
});

const idOf = (r: Run): string => /^\S+\s+(\w{4})\s/.exec(r.out)?.[1] ?? '';
const closer = (id: string): Row | undefined => ledger().find((r) => r.closes === id);

test('--resolves closes an awaiting ask and a queued to-do in one command, citing the new row', () => {
    const ask = idOf(run(['ask', 'which store?', '--searched', 'ledger', ...MARK]));
    const todo = idOf(run(['queue', 'wire the store', ...MARK]));
    const note = run(['note', 'store chosen: sqlite', '--resolves', `${ask},${todo}`, ...MARK]);
    assert.equal(note.code, 0, note.err);
    assert.equal(closer(ask)?.kind, 'resolved');
    assert.equal(closer(todo)?.kind, 'resolved');
    assert.match(closer(ask)?.text ?? '', /resolved by \w{4}/);
});

test('queue --supersedes and --folds drop the older rows with a note pointing at the new one', () => {
    const a = idOf(run(['queue', 'old plan', ...MARK]));
    const b = idOf(run(['queue', 'other old plan', ...MARK]));
    const sup = run(['queue', 'new plan', '--supersedes', a, ...MARK]);
    assert.equal(sup.code, 0, sup.err);
    assert.equal(closer(a)?.kind, 'dropped');
    assert.match(closer(a)?.text ?? '', /superseded by \w{4}/);
    const fold = run(['ask', 'fold question', '--folds', b, '--searched', 'ledger', ...MARK]);
    assert.equal(fold.code, 0, fold.err);
    assert.match(closer(b)?.text ?? '', /folded into \w{4}/);
});

test('--resolves refuses an in-flight row or an unknown id and writes nothing', () => {
    const wip = idOf(run(['start', 'real work', ...MARK]));
    const before = ledger().length;
    const bad = run(['note', 'done maybe', '--resolves', wip, ...MARK]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /in flight/);
    const typo = run(['note', 'oops', '--resolves', 'zzzz', ...MARK]);
    assert.notEqual(typo.code, 0);
    assert.equal(ledger().length, before, 'a refused closing writes no row at all');
});

test('age-out closes a queued row whose ticket gate is a past date, and leaves a live one alone', () => {
    const due = idOf(run(['queue', 'after the freeze', '--gate', 'date:2020-01-01', ...MARK]));
    const later = idOf(run(['queue', 'much later', '--gate', 'date:2999-01-01', ...MARK]));
    const dry = run(['age-out']);
    assert.match(dry.out, new RegExp(`${due}\\s+verified`));
    assert.ok(!dry.out.includes(later));
    assert.equal(closer(due), undefined, 'without --apply nothing is written');
    const applied = run(['age-out', '--apply', ...MARK]);
    assert.equal(applied.code, 0, applied.err);
    assert.equal(closer(due)?.kind, 'resolved');
    assert.equal(closer(later), undefined);
});

test('--gate is refused on a plain note', () => {
    const r = run(['note', 'x', '--gate', 'date:2999-01-01', ...MARK]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--gate goes on/);
});

test('start refuses an epic or umbrella unless --force, for new text and for a queued row with children', () => {
    const before = ledger().length;
    const epic = run(['start', 'Epic: rebuild the importer', ...MARK]);
    assert.notEqual(epic.code, 0);
    assert.match(epic.err, /reads as an epic/);
    assert.equal(ledger().length, before, 'a refused start writes nothing');
    assert.equal(run(['start', 'Epic: rebuild the importer', '--force', ...MARK]).code, 0);

    const parent = idOf(run(['queue', 'importer rebuild tracking', ...MARK]));
    const kid = run(['queue', 'parse the header', '--parent', parent, ...MARK]);
    assert.equal(kid.code, 0, kid.err);
    const promote = run(['start', parent, ...MARK]);
    assert.notEqual(promote.code, 0);
    assert.match(promote.err, /parent of 1 open item/);
    assert.equal(run(['start', idOf(kid), ...MARK]).code, 0, 'the child itself starts normally');
});

test('start always takes a lease, whether it opens new text or promotes a queued row', () => {
    const fresh = idOf(run(['start', 'plain piece of work', ...MARK]));
    const queued = idOf(run(['queue', 'queued piece', ...MARK]));
    run(['start', queued, ...MARK]);
    const held = foldLeases(ledger() as LedgerRow[]);
    for (const id of [fresh, queued]) assert.ok(liveLease(held, id, Date.now()), `${id} carries a live lease`);
});
