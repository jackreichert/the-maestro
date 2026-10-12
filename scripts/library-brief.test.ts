// Run: node --test scripts/library-brief.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { briefBlock } from './lib/library/brief.ts';
import type { FoundPage } from './lib/library/find.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./library-brief.ts', import.meta.url).pathname;
let ledger: string, vault: string;

const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', ledger, '--tickets-vault', vault], { encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
function page(name: string, o: { readWhen: string; status?: string; repo?: string; body: string }): void {
    const file = join(vault, 'Projects', o.repo ?? 'avonlea', 'Knowledge', `${name}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---
type: library
kind: how-it-works
repo: ${o.repo ?? 'avonlea'}
stream: Rivendell
components: [pressing]
status: ${o.status ?? 'current'}
verified-at: 2026-10-01
verify-how: "x"
composed-by: composer
---

# ${name}

Read when: ${o.readWhen}

## Facts

- ${o.body} (verified 2026-10-01, a.md:1)
`);
}

beforeEach(() => {
    ledger = mkdtempSync(join(tmpdir(), 'lbrief-ledger-'));
    vault = mkdtempSync(join(tmpdir(), 'lbrief-vault-'));
    page('orchard-db', { readWhen: 'you connect to the orchard database', body: 'orchard database port 5999' });
    page('pressing', { readWhen: 'you change the nightly pressing', body: 'pressing reads the orchard database nightly' });
    page('gate-api', { readWhen: 'you call the gate api', body: 'gate api pressing endpoint, orchard database untouched' });
    page('credentials', { readWhen: 'a secret looks missing', status: 'stale', body: 'credentials for the orchard database come from env-where' });
    page('elsewhere', { repo: 'other', readWhen: 'unrelated', body: 'orchard database in another repo' });
});

test('a brief for a Avonlea task carries three page paths with their read-when lines', () => {
    const r = run('--repo', 'avonlea', 'orchard database pressing');
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.match(lines[0], /^Library pages for this task/);
    const pages = lines.slice(1);
    assert.equal(pages.length, 3);
    for (const l of pages) assert.match(l, /^- \/.*\/Projects\/avonlea\/Knowledge\/[a-z-]+\.md: you /);
    for (const l of pages) assert.ok(l.startsWith(`- ${vault}/Projects/avonlea/`), l);
    assert.ok(!r.out.includes('/Projects/other/'));
});

test('--json prints the hits; no match still prints the block and says none were found', () => {
    const hits = JSON.parse(run('--repo', 'avonlea', '--json', 'orchard database').out) as FoundPage[];
    assert.equal(hits.length, 3);
    const none = run('--repo', 'avonlea', 'zzzzqqqq');
    assert.equal(none.code, 0);
    assert.match(none.out, /- none found for "zzzzqqqq"/);
});

test('missing words or repo, or an unknown flag, exit 2 and print no block', () => {
    for (const args of [[], ['--repo', 'avonlea'], ['orchard'], ['--repo', 'avonlea', '--wat', 'x']]) {
        const r = run(...args);
        assert.equal(r.code, 2, args.join(' '));
        assert.equal(r.out, '');
    }
});

test('briefBlock caps at three, flags a stale page, and falls back to the title with no read-when line', () => {
    const mk = (i: number, extra: Partial<FoundPage>): FoundPage => ({ path: `Projects/r/Knowledge/p${i}.md`, repo: 'r', kind: 'how-to', title: `T${i}`, readWhen: '', components: [], status: 'current', verifiedAt: '2026-10-01', ageDays: 7, stale: false, score: 0, matched: 'all', ...extra });
    const out = briefBlock([mk(1, { stale: true }), mk(2, {}), mk(3, {}), mk(4, {})], '/v', 'x').split('\n');
    assert.equal(out.length, 4);
    assert.equal(out[1], '- /v/Projects/r/Knowledge/p1.md: T1 [STALE: check the evidence before trusting it]');
    assert.equal(out[2], '- /v/Projects/r/Knowledge/p2.md: T2 [verified 2026-10-01]');
});

test('a read-when line with a secret or PHI shape is withheld from the brief', () => {
    const token = ['gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    page('leaky-one', { readWhen: `you export ${token} and password=hunter2hunter2`, body: 'orchard database leak one' });
    page('leaky-two', { readWhen: 'the patient SSN is 123-45-6789', body: 'orchard database leak two' });
    const r = run('--repo', 'avonlea', 'orchard database leak');
    assert.equal(r.code, 0, r.err);
    for (const frag of ['ghp_', 'hunter2', '123-45-6789']) assert.ok(!r.out.includes(frag), frag);
    assert.ok(r.out.includes('(withheld: fails the secret scan, run library-check)'));
});

test('a wrong vault path or repo name exits 2 with the reason, never an empty block', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, '--repo', 'avonlea', 'orchard', '--vault', ledger, '--tickets-vault', join(vault, 'nowhere')], { encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /No Projects folder/);
    const repo = run('--repo', 'nope', 'orchard');
    assert.equal(repo.code, 2);
    assert.equal(repo.out, '');
    assert.match(repo.err, /No project "nope"/);
});

test('task text with quotes or FTS operators is searched as plain words', () => {
    for (const text of ['fix the "orchard database port', 'orchard database OR', 'NOT orchard database', 'orchard AND OR database', 'orchard (database): can\'t -port*']) {
        const r = run('--repo', 'avonlea', text);
        assert.equal(r.code, 0, `${text}: ${r.err}`);
        assert.match(r.out, /orchard-db\.md/, text);
    }
    assert.equal(run('--repo', 'avonlea', '"" AND').code, 2);
});

test('read-when text that hides a token behind a comment or a zero-width character is withheld from the brief', () => {
    const token = ['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789';
    page('sneaky-one', { readWhen: token.replace('_', '_<!---->'), body: 'orchard database sneaky one' });
    page('sneaky-two', { readWhen: token.replace('_', '_​'), body: 'orchard database sneaky two' });
    const r = run('--repo', 'avonlea', 'orchard database sneaky');
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(r.out.includes('(withheld: fails the secret scan, run library-check)'));
});
