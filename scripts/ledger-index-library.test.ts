// Run: node --test scripts/ledger-index-library.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ageDays, anyWordQuery } from './lib/library/find.ts';

// Hermetic: never read the user's config file (see local-config.ts).
process.env.MAESTRO_LOCAL_CONFIG = '';

const SCRIPT = new URL('./ledger-index.ts', import.meta.url).pathname;
let ledger: string, vault: string;

interface Found { path: string; kind: string; readWhen: string; components: string[]; stale: boolean; status: string; ageDays: number | null; matched: string; neighbors?: { path: string; direction: string }[] }

const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', ledger, '--tickets-vault', vault], { encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const find = (...args: string[]): Found[] => JSON.parse(run('find', ...args, '--json').out);
const paths = (hits: Found[]): string[] => hits.map((h) => h.path.split('/').pop() as string);

/** A library page in the vault; `extra` is more frontmatter lines, `body` replaces the default body. */
function page(rel: string, o: { title: string; readWhen?: string; kind?: string; repo?: string; components?: string; status?: string; verified?: string; extra?: string; body?: string }): string {
    const file = join(vault, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---
type: library
kind: ${o.kind ?? 'how-it-works'}
repo: ${o.repo ?? rel.split('/')[1]}
stream: TeamSelect
components: [${o.components ?? ''}]
status: ${o.status ?? 'current'}
verified-at: ${o.verified ?? '2026-10-01'}
verify-how: "read the page it names"
composed-by: composer
${o.extra ?? ''}---

# ${o.title}

Read when: ${o.readWhen ?? 'you need this topic'}

## Facts

${o.body ?? '- a fact (verified 2026-10-01, README.md:1)'}
`);
    return file;
}

beforeEach(() => {
    ledger = mkdtempSync(join(tmpdir(), 'lfind-ledger-'));
    vault = mkdtempSync(join(tmpdir(), 'lfind-vault-'));
    page('Projects/teamselect/Knowledge/interim-db.md', { title: 'Interim database access', readWhen: 'you must connect to the interim db', components: 'interim-db', body: '- the interim db listens on port 5439 (verified 2026-10-01, infra/interim.md:4)' });
    page('Projects/teamselect/Knowledge/writeback.md', { title: 'Writeback', readWhen: 'you change the nightly writeback', components: 'writeback', extra: 'depends-on: [[interim-db]]\n', body: '- writeback reads the interim table once (verified 2026-10-01, src/wb.ts:9)\n\nSee [[interim-db]] and [[no-such-page]].' });
    page('Projects/teamselect/Runbooks/find-credential.md', { title: 'Find a credential', kind: 'runbook', readWhen: 'a secret looks missing', components: 'secrets', body: '- run env-where with the name (verified 2026-10-01, scripts/env-where:1)' });
    page('Projects/other/Knowledge/port-map.md', { title: 'Port map', repo: 'other', readWhen: 'you need any port', components: 'ports', body: '- ports are listed here (verified 2026-10-01, ports.md:1)' });
});

test('find "interim db" returns the page that holds the port first, with its read-when line and age', () => {
    // A page that merely mentions both words in its body must rank below the page about them.
    page('Projects/teamselect/Knowledge/aaa-decoy.md', { title: 'Misc notes', readWhen: 'you read misc notes', components: 'ports', body: '- the interim db is mentioned once here (verified 2026-10-01, a.md:1)' });
    const hits = find('interim db');
    assert.equal(paths(hits)[0], 'interim-db.md');
    assert.equal(hits[0].readWhen, 'you must connect to the interim db');
    assert.equal(hits[0].matched, 'all');
    assert.ok((hits[0].ageDays ?? -1) >= 7);
    const text = run('find', 'interim db').out;
    assert.match(text.split('\n')[0], /^Projects\/teamselect\/Knowledge\/interim-db\.md {2}\[how-it-works\] {2}verified 2026-10-01 \(\d+d ago\)$/);
    assert.match(text.split('\n')[1], /^ {4}Read when: you must connect to the interim db$/);
});

test('a body-only word still finds the page', () => {
    assert.deepEqual(paths(find('5439')), ['interim-db.md']);
});

test('index counts agree with the page count, and the library is a search source', () => {
    run('index');
    const stats = JSON.parse(run('stats', '--json').out).counts;
    assert.equal(stats.library, 4);
    assert.equal(stats.links, 3);
    const docs = JSON.parse(run('search', 'port', '--source', 'library', '--json').out) as { source: string; ref: string }[];
    assert.ok(docs.length >= 2 && docs.every((d) => d.source === 'library'));
});

test('--repo, --kind and --component narrow the hits', () => {
    assert.deepEqual(paths(find('port', '--repo', 'other')), ['port-map.md']);
    assert.deepEqual(paths(find('name', '--kind', 'runbook')), ['find-credential.md']);
    assert.deepEqual(paths(find('interim', '--component', 'interim-db')), ['interim-db.md']);
    assert.deepEqual(find('interim', '--component', 'interim'), []);
});

test('superseded pages are left out unless asked for, stale pages are flagged', () => {
    page('Projects/teamselect/Knowledge/old-interim.md', { title: 'Old interim db', status: 'superseded', extra: 'superseded-by: [[interim-db]]\n', components: 'interim-db' });
    page('Projects/teamselect/Knowledge/stale-interim.md', { title: 'Stale interim db', status: 'stale', components: 'interim-db' });
    const hits = find('interim db');
    assert.ok(!paths(hits).includes('old-interim.md'));
    assert.equal(hits.find((h) => h.path.endsWith('stale-interim.md'))?.stale, true);
    assert.ok(paths(find('interim db', '--include-superseded')).includes('old-interim.md'));
    assert.match(run('find', 'stale interim').out, /STALE/);
});

test('--neighbors lists pages one link away in both directions and ignores links that resolve to nothing', () => {
    const wb = find('nightly writeback', '--neighbors')[0];
    assert.equal(wb.path.endsWith('writeback.md'), true);
    assert.deepEqual(wb.neighbors?.map((n) => [n.path.split('/').pop(), n.direction]), [['interim-db.md', 'links-to']]);
    const db = find('port 5439', '--neighbors')[0];
    assert.deepEqual(db.neighbors?.map((n) => [n.path.split('/').pop(), n.direction]), [['writeback.md', 'linked-from']]);
    assert.match(run('find', 'port 5439', '--neighbors').out, /<- Projects\/teamselect\/Knowledge\/writeback\.md {2}you change the nightly writeback/);
});

test('a sentence that no page matches word for word falls back to any word and says so', () => {
    const hits = find('how do I reach the interim database port');
    assert.equal(hits[0].matched, 'any');
    assert.equal(paths(hits)[0], 'interim-db.md');
    assert.match(run('find', 'how do I reach the interim database port').out, /^\(no page has every word; showing pages that match any\)/);
});

test('no match is stated, and a query with no words is a usage error', () => {
    assert.equal(run('find', 'zzzzqqqq').out.trim(), '(no library pages match)');
    const r = run('find');
    assert.equal(r.code, 1);
    assert.match(r.err, /Usage: ledger-index\.ts find/);
});

test('find with no library vault is an error, not an empty answer', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'find', 'interim', '--vault', ledger], { encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /library vault is not set/);
});

test('an id-like query with a hyphen is not an FTS syntax error', () => {
    assert.deepEqual(paths(find('interim-db')).slice(0, 1), ['interim-db.md']);
});

test('editing a page is seen by the next find without a manual index', () => {
    assert.deepEqual(find('gizmo'), []);
    const file = page('Projects/teamselect/Knowledge/interim-db.md', { title: 'Interim database access', components: 'interim-db', body: '- the gizmo lives here (verified 2026-10-01, a.md:1)' });
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    assert.deepEqual(paths(find('gizmo')), ['interim-db.md']);
});

test('a page that is not under Knowledge or Runbooks, or an INDEX.md, is not a library page', () => {
    mkdirSync(join(vault, 'Projects/teamselect'), { recursive: true });
    writeFileSync(join(vault, 'Projects/teamselect/INDEX.md'), '---\ntype: library-index\nrepo: teamselect\ncomponents: [interim-db]\n---\n\n# index zebra\n');
    mkdirSync(join(vault, 'Projects/teamselect/Plans'), { recursive: true });
    writeFileSync(join(vault, 'Projects/teamselect/Plans/p.md'), '# plan zebra\n');
    assert.deepEqual(find('zebra'), []);
});

test('ageDays counts whole days and rejects a bad date; anyWordQuery needs two words', () => {
    assert.equal(ageDays('2026-10-01', new Date('2026-10-08T12:00:00Z')), 7);
    assert.equal(ageDays('2026-10-09', new Date('2026-10-08T12:00:00Z')), 0);
    assert.equal(ageDays('', new Date()), null);
    assert.equal(ageDays('soon', new Date()), null);
    assert.equal(anyWordQuery('port'), null);
    assert.equal(anyWordQuery('où est la base provisoire'), '"où" OR "est" OR "la" OR "base" OR "provisoire"');
    assert.equal(anyWordQuery('a port, port 5439'), '"port" OR "5439"');
    assert.equal(anyWordQuery('how do I reach the interim database'), '"reach" OR "interim" OR "database"');
    assert.equal(anyWordQuery(Array.from({ length: 20 }, (_, i) => `w${i}x`).join(' '))?.split(' OR ').length, 12);
});

test('journal.ts find relays the lookup, its flags (including boolean ones before the words) and its exit code', () => {
    const journal = (...args: string[]) => spawnSync(process.execPath, [new URL('./journal.ts', import.meta.url).pathname, 'find', ...args, '--vault', ledger, '--project', 'dev-env', '--tickets-vault', vault], { encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    const hit = journal('--neighbors', 'nightly', 'writeback', '--repo', 'teamselect');
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /^Projects\/teamselect\/Knowledge\/writeback\.md {2}\[how-it-works\]/);
    assert.match(hit.stdout, /-> Projects\/teamselect\/Knowledge\/interim-db\.md/);
    const json = JSON.parse(journal('interim db', '--json', '--limit', '1').stdout) as Found[];
    assert.equal(json.length, 1);
    assert.equal(json[0].path, 'Projects/teamselect/Knowledge/interim-db.md');
    const none = journal();
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Usage: journal\.ts find/);
});

test('a vault path or repo name that does not exist is an error, not "no match"', () => {
    const at = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, 'find', 'interim', ...args, '--vault', ledger], { encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    const badVault = at('--tickets-vault', join(vault, 'nowhere'));
    assert.equal(badVault.status, 1);
    assert.match(badVault.stderr, /No Projects folder under .*nowhere/);
    assert.equal(badVault.stdout, '');
    for (const repo of ['nope', '..', '../..']) {
        const r = at('--tickets-vault', vault, '--repo', repo);
        assert.equal(r.status, 1, repo);
        assert.match(r.stderr, /No project/);
    }
    assert.equal(at('--tickets-vault', vault, '--repo', 'teamselect').status, 0);
});

test('journal.ts find delivers output past 64 KB and past 1 MB intact through a pipe', () => {
    const filler = 'a long sentence about the widget that goes on and on and on '.repeat(25).trim();
    for (let i = 0; i < 800; i += 1) page(`Projects/teamselect/Knowledge/widget-${i}.md`, { title: `Widget ${i}`, readWhen: `${filler} ${i}`, components: 'writeback', body: `- widget fact ${i} (verified 2026-10-01, a.md:1)` });
    const journal = (...args: string[]) => spawnSync(process.execPath, [new URL('./journal.ts', import.meta.url).pathname, 'find', 'widget', ...args, '--vault', ledger, '--project', 'dev-env', '--tickets-vault', vault], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' } });
    for (const limit of ['100', '800']) {
        const r = journal('--limit', limit, '--json');
        assert.equal(r.status, 0, r.stderr);
        assert.equal((JSON.parse(r.stdout) as Found[]).length, Number(limit), `limit ${limit}, ${r.stdout.length} bytes`);
    }
    assert.ok(journal('--limit', '800', '--json').stdout.length > 1024 * 1024);
});
