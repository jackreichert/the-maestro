// Run: node --test scripts/journal-shared.test.ts
// Hermetic: a temp ledger vault, a temp notes vault and a temp container. Never the live ledger.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedDocs, sharedProblems } from './lib/journal/shared.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.MAESTRO_EVENT_DIR = mkdtempSync(join(tmpdir(), 'journal-shared-events-'));

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
let ledgerVault: string;
let notes: string;
let container: string;
let cwd: string;

interface Row { id?: string; kind?: string; text?: string; target?: string; root?: string; sharedKind?: string; sharedProject?: string; why?: string; [k: string]: unknown }
interface Run { code: number | null; out: string; err: string }

function run(...args: string[]): Run {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', ledgerVault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd,
        env: { ...process.env, VAULT_ROOT: notes, LEDGER_ROOT: '', MAESTRO_CONTAINER_ROOT: container, MAESTRO_STATUS_DIR: join(ledgerVault, 'Status'), MAESTRO_PROJECTS_DIR: join(ledgerVault, 'projects'), MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(ledgerVault, 'Events'), MAESTRO_LAUNCH_AGENTS_DIR: join(ledgerVault, 'LaunchAgents') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const ledgerPath = (): string => join(ledgerVault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
const rows = (): Row[] => (existsSync(ledgerPath()) ? readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
const shared = (): Row[] => rows().filter((r) => r.kind === 'shared');
const file = (base: string, ...parts: string[]): string => { const p = join(base, ...parts); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'fake contents\n'); return p; };

beforeEach(() => {
    ledgerVault = mkdtempSync(join(tmpdir(), 'shared-ledger-'));
    notes = mkdtempSync(join(tmpdir(), 'shared-notes-'));
    container = mkdtempSync(join(tmpdir(), 'shared-container-'));
    cwd = mkdtempSync(join(tmpdir(), 'shared-cwd-'));
});

test('a path under the vault and a link are both recorded as pointers, with no absolute path stored', () => {
    const doc = file(notes, 'Projects', 'test-proj', 'Research', 'partner-api.pdf');
    const a = run('shared', doc, '--title', 'Partner API spec', '--why', 'the contract we build against', ...MARK);
    assert.equal(a.code, 0, a.err);
    const b = run('shared', 'https://example.com/design/uat-checklist', '--title', 'UAT checklist', ...MARK);
    assert.equal(b.code, 0, b.err);
    const [first, second] = shared();
    assert.deepEqual([first?.sharedKind, first?.root, first?.target, first?.sharedProject, first?.why], ['path', 'vault', 'Projects/test-proj/Research/partner-api.pdf', 'test-proj', 'the contract we build against']);
    assert.deepEqual([second?.sharedKind, second?.target, second?.root], ['url', 'https://example.com/design/uat-checklist', undefined]);
    assert.ok(!JSON.stringify(shared()).includes(notes), 'the absolute path is never stored');
});

test('a path under the container root is accepted', () => {
    const doc = file(container, 'fake-repo', 'docs', 'runbook.md');
    assert.equal(run('shared', doc, '--title', 'Runbook', ...MARK).code, 0);
    assert.deepEqual([shared()[0]?.root, shared()[0]?.target], ['container', 'fake-repo/docs/runbook.md']);
});

test('a path outside both roots, a missing path, a directory and a symlink out of the roots are refused', () => {
    const outside = file(mkdtempSync(join(tmpdir(), 'shared-outside-')), 'notes.md');
    assert.equal(run('shared', outside, '--title', 'Outside', ...MARK).code, 1);
    assert.equal(run('shared', join(notes, 'missing.md'), '--title', 'Missing', ...MARK).code, 1);
    mkdirSync(join(notes, 'dir'));
    assert.equal(run('shared', join(notes, 'dir'), '--title', 'A directory', ...MARK).code, 1);
    symlinkSync(outside, join(notes, 'escape.md'));
    assert.equal(run('shared', join(notes, 'escape.md'), '--title', 'Escape', ...MARK).code, 1);
    assert.deepEqual(shared(), []);
});

test('a secret-shaped file name is refused, and the refusal never prints the path', () => {
    for (const name of ['.env', '.env.production', 'ssm-prod.json', 'creds.tfvars', 'server.pem', 'credentials.json']) {
        const doc = file(notes, 'Projects', 'test-proj', name);
        const r = run('shared', doc, '--title', 'Config', ...MARK);
        assert.equal(r.code, 1, name);
        assert.ok(!r.err.includes(name), `${name} is not echoed`);
    }
    assert.deepEqual(shared(), []);
});

test('a link must pass the link policy and carry no credentials', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'obsidian://new?vault=v&name=x', 'https://user:pw@example.com/x', 'https://example.com/a b']) {
        assert.equal(run('shared', bad, '--title', 'Bad link', ...MARK).code, 1, bad);
    }
    assert.equal(run('shared', 'obsidian://open?vault=fake&file=Projects%2Fx%2Fnote', '--title', 'A note', ...MARK).code, 0);
    assert.equal(shared().length, 1);
});

test('a title, reason or link that looks like a secret or PHI is refused', () => {
    assert.equal(run('shared', 'https://example.com/x?token=abcDEF123456ghiJKL789', '--title', 'Link', ...MARK).code, 1);
    assert.equal(run('shared', 'https://example.com/x', '--title', 'Patient SSN 123-45-6789', ...MARK).code, 1);
    assert.equal(run('shared', 'https://example.com/x', '--title', 'Fine', '--why', 'password: hunter2hunter2', ...MARK).code, 1);
    assert.equal(run('shared', 'https://example.com/x', ...MARK).code, 1, 'a title is required');
    assert.deepEqual(shared(), []);
});

test('an exact repeat is reported, not written twice; log --kind shared is refused; verify flags a hand-edited row', () => {
    const args = ['shared', 'https://example.com/x', '--title', 'A doc', ...MARK];
    run(...args);
    assert.match(run(...args).out, /already recorded/);
    assert.equal(shared().length, 1);
    assert.equal(run('log', 'x', '--kind', 'shared', ...MARK).code, 1);
    writeFileSync(ledgerPath(), `${readFileSync(ledgerPath(), 'utf8')}${JSON.stringify({ id: 'zz99', ts: '2026-10-11T00:00:00Z', date: '2026-10-11', kind: 'shared', text: 'Edited', target: 'javascript:alert(1)', sharedKind: 'url', by: 'user', sharedProject: 'test-proj' })}\n`);
    const v = run('verify');
    assert.match(v.out + v.err, /shared: the link must be http/);
});

test('a shared row is not a board item', () => {
    run('shared', 'https://example.com/x', '--title', 'A doc', ...MARK);
    const status = JSON.parse(run('status', '--json').out) as { inflight: unknown[]; awaiting: unknown[]; done: unknown[] };
    assert.deepEqual([status.inflight.length, status.awaiting.length, status.done.length], [0, 0, 0]);
});

test('sharedDocs lists one project newest first, one per target, and skips a row that fails the rules', () => {
    const row = (o: Row): Row => ({ kind: 'shared', sharedKind: 'url', by: 'user', sharedProject: 'p1', date: '2026-10-01', text: 'Doc', target: 'https://example.com/a', ...o });
    const list = sharedDocs([
        row({}), row({ date: '2026-10-05', text: 'Doc renamed' }), row({ target: 'https://example.com/b', date: '2026-10-03', text: 'Other' }),
        row({ sharedProject: 'p2', target: 'https://example.com/c' }), row({ target: 'javascript:alert(1)' }), row({ kind: 'note' }),
    ], 'p1');
    assert.deepEqual(list.map((d) => [d.title, d.date]), [['Doc renamed', '2026-10-05'], ['Other', '2026-10-03']]);
    assert.deepEqual(sharedProblems(row({})), []);
    assert.ok(sharedProblems(row({ extra: 1 })).length > 0, 'an unknown field marks a hand edit');
});
