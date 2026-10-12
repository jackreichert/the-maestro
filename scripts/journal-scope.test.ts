// Run: node --test scripts/journal-scope.test.ts
// Hermetic: a temp vault and a temp status dir. Never the live ledger.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

let vault: string;
let statusDir: string;
let files: string;
let cwd: string;

interface Row { id?: string; kind?: string; window?: string; ruleScope?: string; text?: string; [field: string]: unknown }
interface Run { code: number | null; out: string; err: string }

/** Runs journal.ts as one window (`--window`), against the temp vault. */
function runAs(window: string, ...args: string[]): Run {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj', '--window', window], {
        encoding: 'utf8',
        cwd,
        env: {
            ...process.env,
            VAULT_ROOT: '', LEDGER_ROOT: '',
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
const ledger = (): Row[] => (existsSync(ledgerPath()) ? readFileSync(ledgerPath(), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
const memo = (): string => { const path = join(files, 'rule.md'); writeFileSync(path, '# rule\n'); return path; };

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'journal-scope-'));
    statusDir = mkdtempSync(join(tmpdir(), 'journal-scope-status-'));
    files = mkdtempSync(join(tmpdir(), 'journal-scope-files-'));
    cwd = mkdtempSync(join(tmpdir(), 'journal-scope-cwd-'));
});
afterEach(() => { for (const dir of [vault, statusDir, files, cwd]) rmSync(dir, { recursive: true, force: true }); });

test('--scope window on a rule or note writes ruleScope and the writing window', () => {
    assert.equal(runAs('winA', 'rule', 'pause maestro pushes today', '--ref', memo(), '--scope', 'window', ...MARK).code, 0);
    assert.equal(runAs('winA', 'note', 'focus on rest-api', '--scope', 'global', ...MARK).code, 0);
    const [rule, note] = ledger();
    assert.deepEqual([rule?.kind, rule?.ruleScope, rule?.window], ['decision', 'window', 'winA']);
    assert.deepEqual([note?.kind, note?.ruleScope], ['note', 'global']);
});

test('a row written without --scope carries no ruleScope, so it reads as global', () => {
    assert.equal(runAs('winA', 'note', 'plain', ...MARK).code, 0);
    assert.equal(ledger()[0]?.ruleScope, undefined);
});

test('--scope refuses a bad value and a kind that cannot carry it, writing nothing', () => {
    const bad = runAs('winA', 'note', 'x', '--scope', 'everywhere', ...MARK);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--scope must be window or global/);
    const wrongKind = runAs('winA', 'log', 'x', '--kind', 'wip', '--scope', 'window', ...MARK);
    assert.equal(wrongKind.code, 1);
    assert.match(wrongKind.err, /--scope window\|global only goes on/);
    assert.equal(ledger().length, 0);
});

test('with --approval, --scope stays the approval scope and sets no ruleScope', () => {
    assert.equal(runAs('winA', 'log', 'ok to merge docs', '--kind', 'decision', '--approval', 'standing', '--scope', 'docs repos', ...MARK).code, 0);
    const row = ledger()[0];
    assert.deepEqual([row?.scope, row?.ruleScope], ['docs repos', undefined]);
});

/** Window A gives a window rule and a global rule; the text of each is distinct so a view can be searched for it. */
function seedRules(): void {
    assert.equal(runAs('winA', 'rule', 'WINDOW-ONLY pause maestro pushes', '--ref', memo(), '--scope', 'window', ...MARK).code, 0);
    assert.equal(runAs('winA', 'rule', 'GLOBAL branch from staging', '--ref', memo(), '--scope', 'global', ...MARK).code, 0);
    assert.equal(runAs('winA', 'rule', 'LEGACY unscoped rule', '--ref', memo(), ...MARK).code, 0);
}

for (const view of [['prime'], ['status']]) {
    test(`${view.join(' ')}: the window that gave a window rule sees it as binding, with the global rule`, () => {
        seedRules();
        const out = runAs('winA', ...view).out;
        assert.match(out, /WINDOW-ONLY/);
        assert.match(out, /GLOBAL branch/);
    });

    test(`${view.join(' ')}: another window does not see the window rule as binding, only one FYI line, and still sees the global one`, () => {
        seedRules();
        const out = runAs('winB', ...view).out;
        assert.doesNotMatch(out, /WINDOW-ONLY/, 'the rule text must not reach another window');
        assert.match(out, /GLOBAL branch/);
        assert.match(out, /1 (rule|rules) scoped to other windows/i);
    });
}

test('rows without a scope are not listed as rules in force (they read as global, and have their own homes)', () => {
    seedRules();
    assert.doesNotMatch(runAs('winB', 'prime').out, /LEGACY/);
});

test('status --footer counts the rules that bind the window, never their text', () => {
    seedRules();
    const a = runAs('winA', 'status', '--footer').out;
    assert.match(a, /\*\*Rules:\*\* 2 binding here \(1 this window, 1 global\)/);
    assert.doesNotMatch(a, /scoped to other windows/);
    const b = runAs('winB', 'status', '--footer').out;
    assert.match(b, /\*\*Rules:\*\* 1 binding here \(0 this window, 1 global\); 1 rule scoped to other windows \(FYI\)/);
    assert.doesNotMatch(b + a, /WINDOW-ONLY|GLOBAL branch/);
});

for (const lift of ['drop', 'resolve']) {
    test(`a rule that was ${lift === 'drop' ? 'dropped' : 'resolved'} stops binding in prime, status and the footer, for its own window and others`, () => {
        const made = runAs('winA', 'rule', 'WINDOW-ONLY pause pushes', '--ref', memo(), '--scope', 'window', ...MARK);
        const id = made.out.trim().split(/\s+/)[1] ?? '';
        assert.equal(runAs('winA', 'rule', 'GLOBAL keep going', '--ref', memo(), '--scope', 'global', ...MARK).code, 0);
        assert.match(runAs('winA', 'prime').out, /WINDOW-ONLY/);
        assert.equal(runAs('winA', lift, id, 'lifted', ...MARK).code, 0);
        for (const w of ['winA', 'winB']) {
            for (const view of [['prime'], ['status'], ['status', '--footer']]) {
                const out = runAs(w, ...view).out;
                assert.doesNotMatch(out, /WINDOW-ONLY/, `${w} ${view.join(' ')}`);
                assert.doesNotMatch(out, /scoped to other windows/, `${w} ${view.join(' ')}: a lifted rule is not even an FYI`);
            }
        }
        assert.match(runAs('winB', 'prime').out, /GLOBAL keep going/);
    });
}
