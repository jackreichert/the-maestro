// Run: node --test scripts/library-write.test.ts
// Hermetic: a temp vault that is also the ledger root. Fictional repo and facts; no value here is a real secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './library-write.ts';
import { openStore } from './lib/journal/store.ts';
import { begin, curate, writePage } from './lib/library/write.ts';
import type { WriteEnv } from './lib/library/write.ts';
import { pendingLearned } from './lib/library/composer.ts';
import { verifyLedger } from './lib/journal/verify.ts';
import type { LedgerRow } from './lib/ledger-core.ts';

const REPO = 'avonlea-api';
const PROJECT = 'test-proj';
const PAGE = `Projects/${REPO}/Knowledge/orchard-sync.md`;
const MARKS = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:library-write.ts'];

const GOOD = `---
type: library
kind: how-it-works
repo: ${REPO}
stream: Avonlea
components: [orchard-sync]
status: current
verified-at: 2026-10-08@abc1234
verify-how: "read src/sync.ts:40"
composed-by: composer
---
# Orchard sync

Read when: you change how orchards are synced.

## Facts

- The sync runs nightly at 02:00 (verified 2026-10-08, src/sync.ts:40).
`;

const learnedRow = (id: string): LedgerRow => ({ id, ts: '2026-10-10T10:00:00.000Z', date: '2026-10-10', kind: 'learned', text: 'The orchard sync runs nightly.', learnedKind: 'how-it-works', appliesTo: `${REPO}:orchard-sync`, evidence: 'src/sync.ts:40', verifiedAt: '342b177', confidence: 'observed' });

function fixture(): { root: string; stage: (text: string, name?: string) => string; ledger: () => LedgerRow[]; env: (now?: () => string) => WriteEnv; cli: (...a: string[]) => { code: number; out: string; err: string } } {
  const root = mkdtempSync(join(tmpdir(), 'library-write-'));
  mkdirSync(join(root, 'Projects', REPO), { recursive: true });
  writeFileSync(join(root, 'Projects', REPO, 'INDEX.md'), `---\ntype: library-index\nrepo: ${REPO}\ncomponents: [orchard-sync, harvest-export]\n---\n`);
  const store = openStore({ vault: root, project: PROJECT, dryRun: false });
  store.ensureDir();
  const stageDir = mkdtempSync(join(tmpdir(), 'library-stage-'));
  return {
    root,
    stage: (text, name = 'staged.md') => { const p = join(stageDir, name); writeFileSync(p, text); return p; },
    ledger: store.readLedger,
    env: (now = () => new Date().toISOString()) => ({ vault: root, readLedger: store.readLedger, append: store.append, newId: store.newId, now }),
    cli: (...a) => { const out: string[] = []; const err: string[] = []; const code = run([...a, '--vault', root, '--project', PROJECT], { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; },
  };
}
const holderOf = (out: string): string => /holder (\w+)/.exec(out)?.[1] as string;
const leftovers = (root: string): string[] => { const d = join(root, 'Projects', REPO, 'Knowledge'); return existsSync(d) ? readdirSync(d).filter((n) => n.includes('.tmp')) : []; };

test('a second begin exits 3 while the first pass holds the lock, and names when it ends', () => {
  const f = fixture();
  const first = f.cli('begin');
  assert.equal(first.code, 0, first.err);
  const second = f.cli('begin');
  assert.equal(second.code, 3);
  assert.match(second.err, /a composer pass holds the lock until \d\d:\d\d/);
});

test('a lapsed lease is taken by the next begin after its ttl (fake clock), and the old holder is then refused', () => {
  const f = fixture();
  let t = Date.parse('2026-10-10T10:00:00Z');
  const env = f.env(() => new Date(t).toISOString());
  const a = begin(env, 'cmpaaaaaaaa');
  assert.equal(a.ok, true);
  t += 29 * 60_000;
  assert.equal(begin(env, 'cmpbbbbbbbb').ok, false, 'still held at 29 minutes');
  t += 2 * 60_000;
  assert.equal(begin(env, 'cmpbbbbbbbb').ok, true, 'free after the ttl');
  const stale = writePage(env, 'cmpaaaaaaaa', PAGE, f.stage(GOOD));
  assert.equal(stale.ok, false);
  assert.equal(existsSync(join(f.root, PAGE)), false);
});

test('write, curate and end refuse a missing or wrong holder (exit 3) and change nothing', () => {
  const f = fixture();
  assert.equal(f.cli('begin').code, 0);
  f.env().append(learnedRow('lrn1'));
  const staged = f.stage(GOOD);
  for (const args of [['write', PAGE, '--from', staged], ['write', PAGE, '--from', staged, '--holder', 'cmpnotmine1'], ['curate', 'lrn1', '--reject', 'status', ...MARKS, '--holder', 'cmpnotmine1'], ['end', '--holder', 'cmpnotmine1']]) {
    assert.equal(f.cli(...args).code, 3, args.join(' '));
  }
  assert.equal(existsSync(join(f.root, PAGE)), false);
  assert.deepEqual(pendingLearned(f.ledger()).map((r) => r.id), ['lrn1']);
});

test('a page that carries a secret shape is refused, the page does not exist afterwards and no temp file is left', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const bad = GOOD.replace('02:00', ['pass', 'word=hunter2'].join(''));
  const r = f.cli('write', PAGE, '--from', f.stage(bad), '--holder', holder);
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing was written/);
  assert.ok(!r.err.includes('hunter2'), 'the match is never printed');
  assert.equal(existsSync(join(f.root, PAGE)), false);
  assert.deepEqual(leftovers(f.root), []);
});

test('a token split by a comment delimiter is refused by the comment-split check', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const split = `ghp_<!---->${'a1B2'.repeat(9)}`;
  const r = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('02:00', split)), '--holder', holder);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /comment-split:\d+/, 'caught by the comment-split check specifically');
  assert.ok(!r.err.includes(split));
  assert.equal(existsSync(join(f.root, PAGE)), false);
});

test('a token split across a multi-line comment is refused', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const tail = 'a1B2'.repeat(9);
  const split = `ghp_a1B2<!-- (verified 2026-10-08, src/sync.ts:40)\n-->${tail.slice(4)} (verified 2026-10-08, src/sync.ts:40)`;
  const r = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('02:00', split)), '--holder', holder);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /comment-split:page/, 'caught by the whole-page comment-stripped scan');
  assert.ok(!r.err.includes(tail));
  assert.equal(existsSync(join(f.root, PAGE)), false);
});

const PROV = ' (verified 2026-10-08, src/sync.ts:40)';
for (const [name, closer] of [['<!-->', '<!-->'], ['<!--->', '<!--->'], ['--!> closer', null]] as const) {
  test(`a token split by ${name} is refused (a renderer treats it as a complete empty comment)`, () => {
    const f = fixture();
    const holder = holderOf(f.cli('begin').out);
    const tail = 'a1B2'.repeat(9);
    const split = closer ? `ghp_a1B2${closer}${tail.slice(4)}${PROV}` : `ghp_a1B2<!-- c${PROV}\n--!>${tail.slice(4)}${PROV}`;
    const r = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('02:00', split)), '--holder', holder);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /comment-split/);
    assert.ok(!r.err.includes(tail));
    assert.equal(existsSync(join(f.root, PAGE)), false);
  });
}

test('a token split by <!--> mixed with a multi-line comment is refused', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const t = 'a1B2'.repeat(10);
  const split = `ghp_${t.slice(0, 4)}<!-- c${PROV}\n-->${t.slice(4, 14)}<!-->${t.slice(14, 36)}${PROV}`;
  const r = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('02:00', split)), '--holder', holder);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /comment-split/);
  assert.equal(existsSync(join(f.root, PAGE)), false);
});

test('prose with a literal <!-- or <!--> still writes', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const r = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('02:00', '02:00; docs mention <!--> and <!---> and a lone <!-- opener')), '--holder', holder);
  assert.equal(r.code, 0, r.out + r.err);
});

test('a refused rewrite leaves the existing page byte for byte', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  assert.equal(f.cli('write', PAGE, '--from', f.stage(GOOD), '--holder', holder).code, 0);
  const before = readFileSync(join(f.root, PAGE), 'utf8');
  const r = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('nightly at 02:00', ['pass', 'word=hunter2'].join(''))), '--holder', holder);
  assert.equal(r.code, 1);
  assert.equal(readFileSync(join(f.root, PAGE), 'utf8'), before);
});

test('an identical rewrite is a no-op (the file is not touched); composed-by is forced to composer', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const first = f.cli('write', PAGE, '--from', f.stage(GOOD.replace('composed-by: composer', 'composed-by: somebody-else')), '--holder', holder);
  assert.equal(first.code, 0, first.err);
  assert.match(readFileSync(join(f.root, PAGE), 'utf8'), /^composed-by: composer$/m);
  const at = statSync(join(f.root, PAGE)).mtimeMs;
  const again = f.cli('write', PAGE, '--from', f.stage(GOOD), '--holder', holder);
  assert.match(again.out, /^unchanged /);
  assert.equal(statSync(join(f.root, PAGE)).mtimeMs, at);
  assert.deepEqual(leftovers(f.root), []);
});

test('page paths outside Knowledge or Runbooks, with .., or through a symlink are refused', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  const staged = f.stage(GOOD);
  for (const page of [`Projects/${REPO}/Notes/x.md`, `Projects/${REPO}/Knowledge/../Notes/x.md`, `Projects/../Knowledge/x.md`, 'Knowledge/x.md', `Projects/${REPO}/Knowledge/x.txt`]) {
    assert.equal(f.cli('write', page, '--from', staged, '--holder', holder).code, 1, page);
  }
  const outside = mkdtempSync(join(tmpdir(), 'library-outside-'));
  symlinkSync(outside, join(f.root, 'Projects', REPO, 'Knowledge'));
  assert.equal(f.cli('write', PAGE, '--from', staged, '--holder', holder).code, 1);
  assert.deepEqual(readdirSync(outside), []);
});

test('curate closes a pending learned row with the page sha, the ledger still verifies, and a second curate of it is refused', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  f.env().append(learnedRow('lrn1'));
  f.env().append(learnedRow('lrn2'));
  assert.equal(f.cli('write', PAGE, '--from', f.stage(GOOD), '--holder', holder).code, 0);
  const done = f.cli('curate', 'lrn1', '--page', PAGE, '--holder', holder, ...MARKS);
  assert.equal(done.code, 0, done.err);
  const row = f.ledger().find((r) => r.kind === 'curated') as LedgerRow;
  assert.equal(row.closes, 'lrn1');
  assert.equal(row.page, PAGE);
  assert.equal(row.window, holder);
  assert.match(String(row.pageSha), /^[0-9a-f]{64}$/);
  assert.deepEqual(pendingLearned(f.ledger()).map((r) => r.id), ['lrn2']);
  assert.equal(f.cli('curate', 'lrn1', '--reject', 'again', '--holder', holder, ...MARKS).code, 1);
  assert.equal(f.cli('curate', 'zzzz', '--reject', 'unknown', '--holder', holder, ...MARKS).code, 1);
  const { problems } = verifyLedger({ ledgerPath: join(f.root, 'Projects', PROJECT, 'Journal', 'ledger.jsonl'), approvals: new Set(), approvableKinds: new Set(), autocommit: false, dryRun: false, vault: f.root });
  assert.deepEqual(problems, []);
});

test('curate --reject records a one-line reason; a secret shape in it, or a missing page, is refused and writes nothing', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  f.env().append(learnedRow('lrn1'));
  assert.equal(f.cli('curate', 'lrn1', '--reject', ['pass', 'word=hunter2'].join(''), '--holder', holder, ...MARKS).code, 1);
  assert.equal(f.cli('curate', 'lrn1', '--page', PAGE, '--holder', holder, ...MARKS).code, 1, 'the page was never written');
  assert.equal(f.cli('curate', 'lrn1', '--reject', 'a status, not a fact', '--holder', holder, ...MARKS).code, 0);
  assert.equal(f.ledger().filter((r) => r.kind === 'curated').length, 1);
  assert.equal(pendingLearned(f.ledger()).length, 0);
});

test('curate --page refuses a page on disk that fails the checks now (edited by hand after the write)', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  f.env().append(learnedRow('lrn1'));
  assert.equal(f.cli('write', PAGE, '--from', f.stage(GOOD), '--holder', holder).code, 0);
  writeFileSync(join(f.root, PAGE), GOOD.replace('02:00', ['pass', 'word=hunter2'].join('')));
  assert.equal(f.cli('curate', 'lrn1', '--page', PAGE, '--holder', holder, ...MARKS).code, 1);
  assert.equal(f.ledger().filter((r) => r.kind === 'curated').length, 0);
});

test('end frees the lock for the next pass, and ending twice is not an error', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  assert.equal(f.cli('end', '--holder', holder).code, 0);
  assert.equal(f.cli('end', '--holder', holder).code, 0);
  assert.equal(f.cli('begin').code, 0);
});

test('a curate row that library-write would not accept is also what verify flags: usage marks are required unless --allow-unmarked', () => {
  const f = fixture();
  const holder = holderOf(f.cli('begin').out);
  f.env().append(learnedRow('lrn1'));
  assert.equal(f.cli('curate', 'lrn1', '--reject', 'x', '--holder', holder).code, 2);
});

test('several processes racing for the lock: exactly one wins, and it is the holder the ledger names', async () => {
  const f = fixture();
  const worker = new URL('./library-write-race-worker.ts', import.meta.url).pathname;
  const startAt = Date.now() + 1500;
  const results = await Promise.all([0, 1, 2, 3, 4, 5].map(() => new Promise<{ won: boolean; holder: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, f.root, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited ${code}`))));
  })));
  const winners = results.filter((r) => r.won);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const rows = openStore({ vault: f.root, project: 'race', dryRun: false }).readLedger();
  const first = rows.find((r) => r.kind === 'lease');
  assert.equal(first?.window, winners[0]?.holder);
});

test('curate through the core refuses when called with both page and reject', () => {
  const f = fixture();
  const env = f.env();
  const b = begin(env);
  assert.ok(b.ok);
  env.append(learnedRow('lrn1'));
  const r = curate(env, b.ok ? b.holder : undefined, 'lrn1', { page: PAGE, reject: 'x' }, { model: 'm', used: ['u'] });
  assert.equal(r.ok, false);
});
