// Run: node --test scripts/journal-ledger-rules.test.ts
// The ledger writing rules, enforced by the writer: each rule has a test that rejects the bad form.
// Hermetic: a temp vault, status dir and memory dir. Never the live ledger.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { ASK_TEMPLATE } from './lib/ask-template-fixture.ts';
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

const LEARNED = ['--kind', 'how-it-works', '--applies-to', 'fake-repo:fake-api:staging', '--evidence', 'docs/spec.md:12', '--verified-at', '2026-10-08 read the spec', '--confidence', 'observed'];

test('learned without --page or --no-page is refused, names both flags, and writes no row', () => {
    const r = run(['learned', 'The fake api pages by count.', ...LEARNED, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /needs --page <library page>/);
    assert.match(r.err, /--no-page "<why no page changes>"/);
    assert.equal(ledger().length, 0);
});

test('learned --page must name a file that exists in the vault; --no-page needs a reason', () => {
    const missing = run(['learned', 'The fake api pages by count.', ...LEARNED, '--page', 'Library/the-maestro/ghost.md', ...MARK]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /is not a file under the vault/);
    const bare = run(['learned', 'The fake api pages by count.', ...LEARNED, '--no-page', ...MARK]);
    assert.equal(bare.code, 1);
    assert.equal(ledger().length, 0);
});

test('learned --page with an existing page, and --no-page with a reason, both write the row', () => {
    mkdirSync(join(vault, 'Library', 'the-maestro'), { recursive: true });
    writeFileSync(join(vault, 'Library', 'the-maestro', 'api.md'), '# Fake api\n');
    assert.equal(run(['learned', 'The fake api pages by count.', ...LEARNED, '--page', 'Library/the-maestro/api.md', ...MARK]).code, 0);
    assert.equal(run(['learned', 'The fake api caps pages at 50.', ...LEARNED, '--no-page', 'a one-off, no page covers it', ...MARK]).code, 0);
    const rows = ledger().filter((x) => x.kind === 'learned') as (Row & { page?: string; noPage?: string })[];
    assert.equal(rows[0]?.page, 'Library/the-maestro/api.md');
    assert.equal(rows[1]?.noPage, 'a one-off, no page covers it');
});

test('decide without --why is refused and writes neither a file nor a row (already enforced; pinned with the other writing rules)', () => {
    const r = run(['decide', 'Ship the Podium on Fridays', ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /why/i);
    assert.equal(ledger().length, 0);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'DECISIONS.md')), false);
});

test('ask without --recommend is refused and names the flag (already enforced); a --default on a one-way ask is refused', () => {
    const noRecommend = ASK_TEMPLATE.slice(0, ASK_TEMPLATE.indexOf('--recommend'));
    const r = run(['ask', 'Ship Friday or Monday?', '--searched', 'the README', ...noRecommend, ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--recommend/);
    const oneWay = run(['ask', 'Ship Friday or Monday?', '--searched', 'the README', '--door', 'one-way', '--default', 'Friday', ...ASK_TEMPLATE, ...MARK]);
    assert.equal(oneWay.code, 1);
    assert.match(oneWay.err, /one-way ask can never carry a default/);
    assert.equal(ledger().length, 0);
});

test('start and queue refuse a headline over 80 characters, say how to shorten it, and write nothing; 80 passes', () => {
    const long = `${'word '.repeat(16)}end`;   // 83 characters
    for (const verb of ['start', 'queue']) {
        const r = run([verb, long, ...MARK]);
        assert.equal(r.code, 1, verb);
        assert.match(r.err, /headline is 83 characters; keep it to 80 or fewer/);
        assert.match(r.err, /journal\.ts log <id>/);
    }
    assert.equal(ledger().length, 0);
    assert.equal(run(['start', 'x'.repeat(80), ...MARK]).code, 0);
    assert.equal(run(['queue', 'y'.repeat(80), ...MARK]).code, 0);
});

test('queue --machine skips the headline limit for a generated fix line whose key stays parseable; start never does', () => {
    const text = `fix some-long-organisation/a-realistically-long-repository-name#1234 CHECKS-FAILING https://github.com/some-long-organisation/a-realistically-long-repository-name/pull/1234#discussion_r1234567890`;
    assert.ok(text.length > 80);
    assert.equal(run(['queue', text, ...MARK]).code, 1, 'a person-typed queue still refuses');
    assert.equal(run(['queue', text, '--machine', ...MARK]).code, 0);
    assert.equal(run(['start', text, '--machine', ...MARK]).code, 1, '--machine is for queue only');
    assert.equal(ledger().filter((x) => x.text === text).length, 1);
});
