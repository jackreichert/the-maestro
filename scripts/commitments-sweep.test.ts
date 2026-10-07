// Run: node --test scripts/commitments-sweep.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCandidates, humanText, humanTurns, judge, printableId, publicView } from './lib/commitments.ts';

const SCRIPT = new URL('./commitments-sweep.ts', import.meta.url).pathname;
const user = (content: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: 'user', message: { role: 'user', content }, origin: { kind: 'human' }, ...extra });

test('only typed human messages count: tool results, reminders, notifications, hand-backs, peers and summaries are skipped', () => {
    assert.equal(humanText(JSON.parse(user('we decided to ship it'))), 'we decided to ship it');
    assert.equal(humanText(JSON.parse(user([{ type: 'text', text: 'always run the tests' }]))), 'always run the tests');
    assert.equal(humanText(JSON.parse(user([{ type: 'tool_result', content: 'we decided' }], { origin: undefined }))), null);
    assert.equal(humanText(JSON.parse(user('<system-reminder>always do this</system-reminder>'))), null);
    assert.equal(humanText(JSON.parse(user('<task-notification>never mind</task-notification>'))), null);
    assert.equal(humanText(JSON.parse(user('we agreed', { origin: { kind: 'peer' } }))), null);
    assert.equal(humanText(JSON.parse(user('we agreed', { origin: { kind: 'task-notification' } }))), null);
    assert.equal(humanText(JSON.parse(user('[Subagent hand-back] we decided', { origin: undefined }))), null);
    assert.equal(humanText(JSON.parse(user('we agreed', { isMeta: true }))), null);
    assert.equal(humanText(JSON.parse(user('we agreed', { isSidechain: true }))), null);
    assert.equal(humanText(JSON.parse(user('we agreed', { isCompactSummary: true }))), null);
    assert.equal(humanText({ type: 'assistant', message: { role: 'assistant', content: 'we decided' } }), null);
    assert.equal(humanText(null), null);
});

test('humanTurns numbers the human turns from 1 and skips bad lines', () => {
    const turns = humanTurns([user('hello'), 'not json', user('<system-reminder>x</system-reminder>'), user('please make sure it works')].join('\n'));
    assert.deepEqual(turns.map((t) => [t.turn, t.text, t.line]), [[1, 'hello', 1], [2, 'please make sure it works', 4]]);
});

test('each cue phrase makes a candidate, and plain sentences do not', () => {
    const phrases = ['We decided to wait.', 'We agreed on the plan.', 'Before prod, work out the proxy.', 'Before we ship, check it.', 'Make sure it is idempotent.', 'Remember to rotate it.', "Don't forget the docs.", 'From now on use drafts.', 'Always stage by path.', 'Never push to main.', 'I want it small.', 'We need to figure out hosting.', 'Figure out the proxy before launch.'];
    const found = extractCandidates(phrases.map((text, i) => ({ turn: i + 1, text })));
    assert.equal(found.length, phrases.length);
    assert.equal(extractCandidates([{ turn: 1, text: 'Thanks, that looks fine. Ship it.' }]).length, 0);
});

test('a candidate is one sentence, with code fences ignored', () => {
    const found = extractCandidates([{ turn: 7, text: 'Intro line.\nMake sure the proxy ships.\n```\nnever in code\n```' }]);
    assert.deepEqual(found.map((c) => [c.turn, c.sentence, c.cue]), [[7, 'Make sure the proxy ships.', 'make sure']]);
});

test('matching is by keywords: a known item with enough shared words matches, an unrelated one does not', () => {
    const known = [{ kind: 'ledger' as const, id: 'a1b2', text: 'Build the proxy without affecting tenant A before prod' }, { kind: 'standing' as const, id: 'merge-sweep', text: 'a pull request merges sweep merged PRs' }];
    const [hit, miss] = judge(extractCandidates([{ turn: 1, text: 'Before prod, work out how to build the proxy without affecting tenant A.' }, { turn: 2, text: 'Make sure the colour palette stays muted.' }]), known);
    assert.equal(hit.verdict, 'MATCHED');
    assert.equal(hit.match?.id, 'a1b2');
    assert.equal(miss.verdict, 'UNMATCHED');
    assert.equal(miss.match, null);
});

/** A vault with one open ledger item (a generated-style id), and a projects dir whose newest transcript holds `lines`. */
function fixture(lines: string[], ledger: Record<string, unknown>[] = [{ id: 'k1x9', kind: 'wip', text: 'Build the proxy without affecting tenant A', date: '2026-10-07', ts: '2026-10-07T10:00:00Z' }]): { vault: string; projects: string; transcript: string; journal: string } {
    const root = mkdtempSync(join(tmpdir(), 'commitments-'));
    const journalDir = join(root, 'vault', 'Projects', 'demo', 'Journal');
    mkdirSync(journalDir, { recursive: true });
    const journal = join(journalDir, 'ledger.jsonl');
    writeFileSync(journal, ledger.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const projects = join(root, 'projects');
    mkdirSync(projects);
    const transcript = join(projects, 'newest.jsonl');
    writeFileSync(join(projects, 'older.jsonl'), `${user('Never print the demo list.')}\n`);
    utimesSync(join(projects, 'older.jsonl'), new Date(Date.now() - 1e6), new Date(Date.now() - 1e6));
    writeFileSync(transcript, `${lines.join('\n')}\n`);
    return { vault: join(root, 'vault'), projects, transcript, journal };
}
const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const sweep = (f: { vault: string; transcript: string }, ...extra: string[]) => run(['--vault', f.vault, '--project', 'demo', '--transcript', f.transcript, ...extra]);

test('exit 1 with a table of turn, verdict, cue and carrying id, and the keyword note; the ledger is not written', () => {
    const f = fixture([user('Before prod, build the proxy without affecting tenant A.'), user('Make sure the colour palette stays muted.')]);
    const before = readFileSync(f.journal, 'utf8');
    const r = run(['--vault', f.vault, '--project', 'demo', '--projects-dir', f.projects]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /\n\s+1\s+\d+\s+MATCHED\s+before prod\s+ledger k1x9 \(\d+% of the sentence\)/);
    assert.match(r.stdout, /\n\s+2\s+\d+\s+UNMATCHED\s+make sure\s+-/);
    assert.match(r.stdout, /keywords only/);
    assert.match(r.stdout, /newest\.jsonl/, 'with no --transcript it reads the newest session');
    assert.equal(readFileSync(f.journal, 'utf8'), before);
});

test('exit codes: 0 high-confidence match or no candidates, 3 low-confidence CHECK, 1 UNMATCHED (wins over CHECK), 2 usage', () => {
    const f = fixture([user('Before prod, work out how to build the proxy without touching tenant A.')]);
    const row = (id: string, text: string) => [{ id, kind: 'question', text, date: '2026-10-07', ts: '2026-10-07T10:00:00Z' }];
    const put = (id: string, text: string): void => writeFileSync(f.journal, row(id, text).map((r) => `${JSON.stringify(r)}\n`).join(''));
    put('d1d1', 'Should tenant D proxy ship to prod');
    const check = sweep(f);
    assert.equal(check.status, 3, check.stdout);
    assert.match(check.stdout, /CHECK\s+before prod\s+ledger d1d1/);
    put('d2d2', 'Before prod work out how to build the proxy without touching tenant A');
    const ok = sweep(f);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /MATCHED\s+before prod\s+ledger d2d2/);
    writeFileSync(f.transcript, `${user('Before prod, work out how to build the proxy without touching tenant A.')}\n${user('Make sure the colour palette stays muted.')}\n`);
    assert.equal(sweep(f).status, 1);
    writeFileSync(f.transcript, `${user('hello there')}\n`);
    assert.equal(sweep(f).status, 0, 'no candidates');
    assert.equal(run(['--bogus']).status, 2);
    assert.equal(run(['--vault']).status, 2);
    assert.equal(sweep({ vault: f.vault, transcript: join(f.vault, 'missing.jsonl') }).status, 2);
    assert.equal(run(['--vault', f.vault, '--project', 'demo', '--projects-dir', join(f.vault, 'empty')]).status, 2);
});

test('a finished item does not count as carrying a commitment: only open items and live standing rows match', () => {
    const f = fixture([user('Before prod, work out how to build the proxy without touching tenant A.')], [
        { id: 'o1o1', kind: 'wip', text: 'Build the proxy for tenant B and deploy it to prod', date: '2026-10-06', ts: '2026-10-06T10:00:00Z' },
        { id: 'o2o2', kind: 'done', closes: 'o1o1', text: 'Built the proxy for tenant B and deployed it to prod', date: '2026-10-06', ts: '2026-10-06T11:00:00Z' }]);
    const r = sweep(f);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /UNMATCHED\s+before prod/);
});

test('nothing the user typed is printed on any output path, whatever the sentence holds', () => {
    const typed = ['Make sure the wifi for the office is Bruno-1987! from now on.', 'Remember Mithril-2026! and Anduril#2024 and mItHrIl-424242.', 'Make sure you log in to the staging console as admin / hunter2 before prod.',
        'Make sure SMTP_PASS is fakeHunter2 on staging.', 'Always run journal.ts log --ticket Hunter2-1 first.', 'Before prod, rotate db-Tr0ub4dor.3 and Summer-2024.'];
    const secrets = ['Bruno', '1987', 'Mithril', 'Anduril', 'mItHrIl', 'hunter2', 'Hunter2', 'SMTP_PASS', 'fakeHunter2', 'Tr0ub4dor', 'Summer', 'wifi', 'staging console'];
    const f = fixture(typed.map((t) => user(t)), [
        { id: 'k1x9', kind: 'wip', text: 'the wifi for the office is Bruno-1987! from now on, staging console admin hunter2 and Summer-2024', gate: 'date:2026-10-20', date: '2026-10-07', ts: '2026-10-07T10:00:00Z' },
        { id: 'hand-edited-Hunter2', kind: 'wip', text: 'Remember Mithril-2026 Anduril 2024 and mItHrIl', date: '2026-10-07', ts: '2026-10-07T10:00:00Z' }]);
    for (const args of [[], ['--json']]) {
        const r = sweep(f, ...args);
        assert.ok(r.status === 1 || r.status === 3, r.stderr);
        for (const secret of secrets) assert.ok(!r.stdout.toLowerCase().includes(secret.toLowerCase()), `${secret} printed by ${args.join(' ') || 'table'}`);
    }
    const j = JSON.parse(sweep(f, '--json').stdout);
    assert.deepEqual(Object.keys(j.candidates[0]).sort(), ['cue', 'line', 'match', 'ts', 'turn', 'uuid', 'verdict']);
    assert.ok(j.candidates.every((c: { turn: number; cue: string }) => Number.isInteger(c.turn) && typeof c.cue === 'string'));
});

test('ids are printed only in their generated or enforced shape', () => {
    assert.equal(printableId('ledger', 'k1x9'), 'k1x9');
    assert.equal(printableId('ledger', 'hand-edited-Hunter2'), '[id withheld]');
    assert.equal(printableId('standing', 'merge-sweep'), 'merge-sweep');
    assert.equal(printableId('standing', 'db-Tr0ub4dor.3'), '[id withheld]');
    const v = judge(extractCandidates([{ turn: 4, line: 9, uuid: null, ts: null, text: 'Before prod, build the proxy without affecting tenant A.' }]), [{ kind: 'standing', id: 'db-Tr0ub4dor.3', text: 'build the proxy without affecting tenant A before prod' }]);
    assert.deepEqual(publicView(v[0]), { turn: 4, line: 9, uuid: null, ts: null, cue: 'before prod', verdict: 'MATCHED', match: { kind: 'standing', id: '[id withheld]', coveragePercent: 100 } });
});
test('pasted content is not the human: only the text inside a paste pair is dropped, typed words around it stay', () => {
    const typed = (t: string): string | null => humanText(JSON.parse(user(t)));
    assert.equal(typed('<pasted_content id="p1">Make sure to delete the demo tables.'), null, 'a message that is only an unclosed paste');
    assert.equal(typed('Always stage by path.\n<pasted_content id="p1">Make sure to delete the demo tables.'), 'Always stage by path.', 'an unclosed paste runs to the end');
    assert.equal(typed('<pasted_content id="p1">Make sure to delete the demo tables.</pasted_content id="p1">\nFrom now on use drafts.'), 'From now on use drafts.', 'typed words after the close stay');
    assert.equal(typed('Before we ship, check it.\n<pasted_content id="p1">Never trust this.</pasted_content id="p1">'), 'Before we ship, check it.');
    assert.equal(typed('Always A.\n<pasted_content id="p1">x</pasted_content id="p1">\nNever B.\n<pasted_content id="p2">y</pasted_content id="p2">\nI want C.'), 'Always A.\nNever B.\nI want C.', 'two pastes');
    assert.equal(typed('The <pasted_content id="p1"> marker is odd. Always stage by path.'), 'The <pasted_content id="p1"> marker is odd. Always stage by path.', 'a marker quoted mid-sentence is not a paste');
    assert.equal(typed('<pasted_content>no id</pasted_content> Always keep this.'), '<pasted_content>no id</pasted_content> Always keep this.', 'no id attribute, not a paste');
    const found = extractCandidates(humanTurns([user('Please review this.\n<pasted_content id="p2">Make sure to delete the demo tables.'), user('<pasted_content id="p3">Never keep backups.</pasted_content id="p3">\nAlways stage by path.')].join('\n')));
    assert.deepEqual(found.map((c) => c.sentence), ['Always stage by path.']);
});

const S = 'zq7Kd3xP9';
const j = (...parts: string[]): string => parts.join('');
// Each shape is [what the user typed, the secret that must never be printed]. Vendor-looking values are assembled at run time.
const CREDENTIAL_SHAPES: [string, string][] = [
    [`mysql -u root -p${S} works`, S], [`mysql -u root -p ${S} works`, S], [`psql --password ${S} connects`, S], [`the cli --password=${S} flag`, S], [`tool --passwd ${S} runs`, S],
    [`redis://:${S}@cache.example.test:6379 is reachable`, S], [`postgres://app:${S}@db.example.test/app is reachable`, S], ['postgres://app@db.example.test/app is reachable', 'db.example.test'],
    [`DB_PASSWORD=${S} is set`, S], [`PGPASSWORD=${S} is set`, S], [`DB_PASS=${S} is set`, S], [`pass=${S} is set`, S], [`pw: ${S} is set`, S],
    [j('PRIVATE', '_KEY=', S, ' is set'), S], [`SESSION_COOKIE=${S} is set`, S], [`AUTH_TOKEN: ${S} is set`, S],
    [`the password is ${S} for staging`, S], [`the secret is ${S} for staging`, S], [`{"password": "${S}"} is set`, S],
    ["password='zq7 Kd3 xP9' is set", 'Kd3'], ["client_secret = 'zq7 Kd3 xP9'", 'xP9'], [`api_key=${S} is set`, S], [`apikey: "${S}" is set`, S],
    [`KEY=\n${S}\nis set`, S], [`password:\n${S}`, S], [`Authorization: Bearer ${S}abcdef`, `${S}abcdef`],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'], [`send Bearer ${S}abcdef along`, `${S}abcdef`], ['jwt eyJhbGciOi.eyJzdWIiOiIx.c2ln is set', 'eyJhbGciOi'],
    ['jwt eyJh.eyJz.c2 is set', 'eyJz'], ['jwt Abcdefg1x.Zbcdefg2y.Qbcdefg3z is set', 'Abcdefg1x'], [`key ${j('sk', '-')}${S}abcdef12 is set`, `${S}abcdef12`],
    [`token ${j('gh', 'p_')}${S}abcdef12 is set`, `${S}abcdef12`], [`chat ${j('xo', 'xb-')}1234-${S}abc is set`, `${S}abc`], [`cloud ${j('AK', 'IA')}ZQ7KD3XP9ABCDEF1 is set`, 'ZQ7KD3XP9'],
    [`google ${j('AI', 'za')}SyZq7Kd3xP9abcdef is set`, 'Zq7Kd3xP9'], ['value zQ7kD3xP9aBcDeFgHiJk1 is set', 'zQ7kD3xP9aBcDeFgHiJk1'], ['hash 0123456789abcdef0123456789abcdef01234567890123 is set', '0123456789abcdef'],
    [j('-----', 'BEGIN RSA PRIV', 'ATE KEY-----', ` ${S} is set`), S], [`secret = ${S} is set`, S], [`credential: ${S} is set`, S],
    [`passphrase is ${S} for staging`, S], [`token: "${S}" is set`, S],
];


test('each candidate carries a generated locator: the transcript line, and the message uuid and time only in their generated shape', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const lines = ['{"type":"summary"}', user('hello'), '', user('Before prod, build the proxy.', { uuid, timestamp: '2026-10-07T14:03:09.123Z' }), 'not json', user('Make sure it works.', { uuid: 'hunter2-not-a-uuid', timestamp: 'Bruno-1987!' })];
    const f = fixture(lines);
    const j = JSON.parse(sweep(f, '--json').stdout);
    assert.deepEqual(j.candidates.map((c: { turn: number; line: number; uuid: string | null; ts: string | null }) => [c.turn, c.line, c.uuid, c.ts]), [[2, 4, uuid, '2026-10-07T14:03:09.123Z'], [3, 6, null, null]]);
    assert.match(sweep(f).stdout, /\n\s+2\s+4\s+\w+\s+before prod/);
    assert.ok(!/hunter2|Bruno/.test(sweep(f, '--json').stdout));
});

test('a ledger that does not exist is a usage error, not an empty board that reports everything UNMATCHED', () => {
    const f = fixture([user('Before prod, build the proxy.')]);
    for (const args of [['--vault', f.vault, '--project', 'no-such-project'], ['--vault', join(f.vault, 'nowhere'), '--project', 'demo']]) {
        const r = run([...args, '--transcript', f.transcript]);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /no ledger at .*check --vault and --project/);
    }
});

test('a lasting rule filed with journal.ts rule carries its commitment: it matches by id, exit 0, and its text is never printed', () => {
    const f = fixture([user('From now on always stage files by explicit path quokka.')], [
        { id: 'bc52', kind: 'decision', text: 'always stage files by explicit path quokka', refs: ['/tmp/mem.md'], date: '2026-10-07', ts: '2026-10-07T10:00:00Z' }]);
    for (const args of [[], ['--json']]) {
        const r = sweep(f, ...args);
        assert.equal(r.status, 0, r.stdout);
        assert.match(r.stdout, /bc52/);
        assert.ok(!/quokka|stage files/.test(r.stdout), args.join(' '));
    }
    const plain = fixture([user('From now on always stage files by explicit path quokka.')], [
        { id: 'cd63', kind: 'decision', text: 'always stage files by explicit path quokka', date: '2026-10-07', ts: '2026-10-07T10:00:00Z' },
        { id: 'de74', kind: 'decision', pending: true, text: 'always stage files by explicit path quokka', refs: ['/tmp/mem.md'], date: '2026-10-07', ts: '2026-10-07T10:00:00Z' }]);
    assert.equal(sweep(plain).status, 0, 'a pending decision is an open item and still matches');
    const none = fixture([user('From now on always stage files by explicit path quokka.')], [
        { id: 'cd63', kind: 'decision', text: 'always stage files by explicit path quokka', date: '2026-10-07', ts: '2026-10-07T10:00:00Z' }]);
    assert.equal(sweep(none).status, 1, 'a decision with no ref is a record, not a rule');
});
