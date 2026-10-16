// Run: node --test scripts/journal-ledger-scan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'claude-opus-5-5', '--used', 'skill:the-maestro,tool:journal.ts'];

/** Shapes, built in pieces so this file itself holds no literal that looks like a credential. Every value is fictional. */
const SHAPES: Record<string, string> = {
    ssn: ['078', '05', '1120'].join('-'),
    dob: `DOB ${['03', '14', '1950'].join('/')}`,
    mrn: `MRN: ${['A', '1234567'].join('')}`,
    'aws-key': `${'AKIA'}${'ABCDEFGHIJKLMNOP'}`,
    'github-token': `${'ghp'}_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`,
    'password-assignment': `password=${'Hunter2'}${'Hunter2'}`,
    'url-credentials': `postgres://svc:${'S3cretPw9'}@db.example.test/app`,
};

function fixture(): { vault: string; run: (...a: string[]) => { code: number | null; out: string; err: string }; rows: () => string } {
    const vault = mkdtempSync(join(tmpdir(), 'ledger-scan-'));
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Journal'), { recursive: true });
    const cwd = mkdtempSync(join(tmpdir(), 'ledger-scan-cwd-'));
    const run = (...args: string[]) => {
        const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
            encoding: 'utf8', cwd, env: { ...process.env, VAULT_ROOT: '', MAESTRO_WINDOW: 'testwin', MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: join(vault, 'Events') },
        });
        return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const rows = (): string => { const p = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
    return { vault, run, rows };
}

/** An ask with the whole template filled in, the text and the searched note as given. */
const ask = (text: string, searched: string): string[] => ['ask', text, '--searched', searched, '--blocked', 'the merge', '--option', 'a -- cheap', '--option', 'b -- slow', '--recommend', 'a, it is cheaper', '--link', 'https://example.test/pull/1', '--door', 'two-way'];

/** Each free-text writer, as the command that writes it with `text` in its prose. */
const WRITERS: [string, (text: string) => string[]][] = [
    ['log', (t) => ['log', t]],
    ['note', (t) => ['note', t]],
    ['ask', (t) => ask(t, 'docs and the ledger')],
    ['ask --searched', (t) => ask('which db?', t)],
    ['rule', (t) => ['rule', t, '--ref', SCRIPT]],
    ['start', (t) => ['start', t]],
    ['queue', (t) => ['queue', t]],
];

for (const [name, argsFor] of WRITERS) {
    test(`${name}: every secret and PHI shape is refused with its field and rule named, the value never echoed, and nothing written`, () => {
        const f = fixture();
        for (const [shape, value] of Object.entries(SHAPES)) {
            const r = f.run(...argsFor(`fixed the sync, context ${value} end`), ...MARK);
            assert.equal(r.code, 1, `${shape}: ${r.err}`);
            assert.match(r.err, /refused: the ledger is durable and shared/, shape);
            assert.ok(!(r.out + r.err).includes(value), `${shape}: the value was echoed`);
        }
        assert.equal(f.rows(), '', 'a refused row leaves no trace');
    });

    test(`${name}: a clean row, with paths, shas, commands and placeholders, is written`, () => {
        const f = fixture();
        const text = 'merged scripts/lib/journal/store.ts at commit 52c927bd3f1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b, ran `node --test`, PASSWORD=<redacted>, token=$TOKEN';
        const r = f.run(...argsFor(text), ...MARK);
        assert.equal(r.code, 0, r.err);
        assert.match(f.rows(), /52c927bd3f1e/);
    });
}

test('the refusal names the field and the rule for the text it came from', () => {
    const f = fixture();
    const r = f.run('note', `contact ${SHAPES.ssn}`, ...MARK);
    assert.match(r.err, /text: looks like PHI \(ssn\)/);
});

test('handoff --learn and --next refuse the same shapes and write no handoff file', () => {
    const f = fixture();
    for (const flag of ['--learn', '--next']) {
        const r = f.run('handoff', '--all', flag, `see ${SHAPES['aws-key']}`);
        assert.equal(r.code, 1, r.err);
        assert.ok(!(r.out + r.err).includes(SHAPES['aws-key']));
    }
    const dir = join(f.vault, 'Projects', 'test-proj', 'Journal');
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('HANDOFF-')), []);
});

test('verify warns about an old row that carries a shape, by id, field and rule, and still exits 0', () => {
    const f = fixture();
    assert.equal(f.run('note', 'clean row', ...MARK).code, 0);
    const path = join(f.vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    appendFileSync(path, `${JSON.stringify({ id: 'old1', ts: '2026-01-01T00:00:00Z', date: '2026-01-01', kind: 'note', text: `legacy ${SHAPES.ssn}` })}\n`);
    const r = f.run('verify');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /warning: 1 row\(s\) carry a secret or PHI shape/);
    assert.match(r.out, /\[old1\] text: looks like PHI \(ssn\)/);
    assert.ok(!r.out.includes(SHAPES.ssn as string));
});
