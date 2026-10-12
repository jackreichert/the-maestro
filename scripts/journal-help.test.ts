// Run: node --test scripts/journal-help.test.ts
// Hermetic: a temp ledger root, a temp HOME and a temp status dir. Never the live ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS } from './lib/journal/help.ts';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;

interface Sandbox { root: string; vault: string; home: string; status: string; cwd: string }

/** A temp ledger with one finished item from today, so a real `roll` would have something to archive. */
function sandbox(): Sandbox {
    const root = mkdtempSync(join(tmpdir(), 'journal-help-'));
    const s = { root, vault: join(root, 'vault'), home: join(root, 'home'), status: join(root, 'status'), cwd: join(root, 'cwd') };
    for (const d of [s.home, s.status, s.cwd]) mkdirSync(d);
    const journal = join(s.vault, 'Projects', 'test-proj', 'Journal');
    mkdirSync(journal, { recursive: true });
    const row = { id: 'aaaa', ts: new Date().toISOString(), kind: 'done', text: 'an old finished item', model: 'Test Model', used: 'skill:x' };
    writeFileSync(join(journal, 'ledger.jsonl'), `${JSON.stringify(row)}\n`);
    return s;
}

/** Every file under `dir` with a content hash: a write, a rename or a delete anywhere changes it. */
function snapshot(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return [`${p}/`, ...snapshot(p)];
        return [`${p} ${statSync(p).size} ${createHash('sha1').update(readFileSync(p)).digest('hex')}`];
    }).sort();
}

/** `after` goes behind the global flags, which is where a `--` terminator and its literal words belong. */
function run(s: Sandbox, args: string[], after: string[] = []): { code: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', s.vault, '--project', 'test-proj', ...after], {
        encoding: 'utf8',
        cwd: s.cwd,
        timeout: 20_000,
        env: {
            ...process.env,
            HOME: s.home,
            VAULT_ROOT: '',
            LEDGER_ROOT: '',
            MAESTRO_LOCAL_CONFIG: '',
            MAESTRO_STATUS_DIR: s.status,
            MAESTRO_PROJECTS_DIR: join(s.vault, 'projects'),
            MAESTRO_CONTAINER_ROOT: '',
            MAESTRO_UPDATE_CHECK: 'off',
            MAESTRO_EVENT_DIR: join(s.vault, 'Events'),
            MAESTRO_LAUNCH_AGENTS_DIR: join(s.vault, 'LaunchAgents'),
            MAESTRO_NOTIFY_COMMAND: '/usr/bin/true',
        },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Run `body` in a fresh sandbox and remove it afterwards. */
function inSandbox(body: (s: Sandbox) => void): void {
    const s = sandbox();
    try { body(s); } finally { rmSync(s.root, { recursive: true, force: true }); }
}

test('the table names every command the dispatch handles, and no other', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const dispatch = source.slice(source.indexOf('switch (cmd) {'));
    const handled = new Set([...dispatch.matchAll(/case '([\w-]+)'/g)].map((m) => m[1]));
    for (const early of ['autopull', 'settings']) handled.add(early);
    assert.deepEqual([...handled].sort(), COMMANDS.map((c) => c.name).sort());
});

for (const command of COMMANDS) {
    for (const flag of ['--help', '-h']) {
        test(`${command.name} ${flag} prints its usage and writes nothing`, () => inSandbox((s) => {
            const before = snapshot(s.root);
            const r = run(s, [command.name, flag]);
            assert.deepEqual(snapshot(s.root), before, 'help changed files');
            assert.equal(r.code, 0, r.err);
            assert.match(r.out, new RegExp(`journal\\.ts ${command.name}\\b`));
            assert.ok(r.out.includes(command.summary), 'the usage carries the command summary');
            for (const [f] of command.flags) assert.ok(r.out.includes(f), `the usage lists ${f}`);
        }));
    }
}

test('--help, -h and help list every command and exit 0', () => inSandbox((s) => {
    for (const args of [['--help'], ['-h'], ['help']]) {
        const r = run(s, args);
        assert.equal(r.code, 0, r.err);
        for (const c of COMMANDS) assert.ok(r.out.includes(`  ${c.name} `), `${args.join(' ')} lists ${c.name}`);
    }
}));

test('help <command> prints that command only', () => inSandbox((s) => {
    const r = run(s, ['help', 'roll']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /journal\.ts roll /);
    assert.doesNotMatch(r.out, /journal\.ts standup /);
}));

test('help is answered with no project and no ledger root', () => inSandbox((s) => {
    const r = spawnSync(process.execPath, [SCRIPT, 'roll', '--help'], {
        encoding: 'utf8',
        cwd: s.cwd,
        env: { ...process.env, HOME: s.home, VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_PROJECT: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /journal\.ts roll /);
}));

test('an unknown command prints the list and exits non-zero without writing', () => inSandbox((s) => {
    const before = snapshot(s.root);
    const r = run(s, ['frobnicate']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /Unknown command: frobnicate/);
    for (const c of COMMANDS) assert.ok(r.err.includes(`  ${c.name} `), `lists ${c.name}`);
    assert.notEqual(run(s, ['frobnicate', '--help']).code, 0);
    assert.deepEqual(snapshot(s.root), before);
}));

const MARKS = ['--model', 'Test Model', '--used', 'skill:x'];
const ledgerRows = (s: Sandbox): { kind?: string; text?: string }[] => readFileSync(join(s.vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('after a -- terminator, --help and -h are text: log -- --help writes the literal words', () => inSandbox((s) => {
    for (const word of ['--help', '-h']) {
        const before = ledgerRows(s).length;
        const r = run(s, ['log', ...MARKS], ['--', word]);
        assert.equal(r.code, 0, r.err);
        assert.doesNotMatch(r.out, /journal\.ts log /, 'it must not print usage');
        const rows = ledgerRows(s);
        assert.equal(rows.length, before + 1, 'a row was written');
        assert.equal(rows.at(-1)?.text, word);
    }
    const flagged = run(s, ['log', '--help']);
    assert.match(flagged.out, /journal\.ts log /, 'before the terminator it is still help');
}));

test('a flag first still names the command: -h roll and --help roll print roll usage', () => inSandbox((s) => {
    const before = snapshot(s.root);
    for (const flag of ['-h', '--help']) {
        const r = run(s, [flag, 'roll']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /journal\.ts roll /);
        assert.doesNotMatch(r.out, /journal\.ts standup /);
    }
    assert.deepEqual(snapshot(s.root), before);
}));
