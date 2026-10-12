// Run: node --test scripts/library-write-miss.test.ts
// Hermetic: a temp vault that is also the ledger root. Fictional repo and facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './library-write.ts';
import { openStore } from './lib/journal/store.ts';
import { pendingMisses } from './lib/journal/miss.ts';
import { verifyLedger } from './lib/journal/verify.ts';
import type { LedgerRow } from './lib/ledger-core.ts';

const REPO = 'avonlea-api';
const PROJECT = 'test-proj';
const PAGE = `Projects/${REPO}/Knowledge/orchard-sync.md`;
const MARKS = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:library-write.ts'];
const PAGE_TEXT = `---
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

Read when: you rebuild the orchard index.

## Facts

- The index is rebuilt by the nightly sync at 02:00 (verified 2026-10-08, src/sync.ts:40).
`;

const missRow = (id: string, text: string): LedgerRow => ({ id, ts: '2026-10-10T10:00:00.000Z', date: '2026-10-10', kind: 'miss', text, source: 'find', topic: 'index orchard rebuild', repo: REPO });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'library-write-miss-'));
  mkdirSync(join(root, 'Projects', REPO), { recursive: true });
  writeFileSync(join(root, 'Projects', REPO, 'INDEX.md'), `---\ntype: library-index\nrepo: ${REPO}\ncomponents: [orchard-sync]\n---\n`);
  const store = openStore({ vault: root, project: PROJECT, dryRun: false });
  store.ensureDir();
  const staged = join(mkdtempSync(join(tmpdir(), 'library-stage-')), 'staged.md');
  writeFileSync(staged, PAGE_TEXT);
  const cli = (...a: string[]) => { const out: string[] = []; const err: string[] = []; const code = run([...a, '--vault', root, '--project', PROJECT], { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; };
  const problems = () => verifyLedger({ ledgerPath: join(root, 'Projects', PROJECT, 'Journal', 'ledger.jsonl'), approvals: new Set(), approvableKinds: new Set(), autocommit: false, dryRun: false, vault: root }).problems;
  return { root, staged, ledger: store.readLedger, append: store.append, cli, problems };
}

test('a fixture pass answers a miss with a page: the miss is closed naming the page, and verify is clean', () => {
  const f = fixture();
  f.append(missRow('mis1', 'how do i rebuild the orchard index'));
  const holder = /holder (\w+)/.exec(f.cli('begin').out)?.[1] as string;
  assert.equal(f.cli('write', PAGE, '--from', f.staged, '--holder', holder).code, 0);
  const done = f.cli('curate', 'mis1', '--page', PAGE, '--holder', holder, ...MARKS);
  assert.equal(done.code, 0, done.err);
  const closer = f.ledger().find((r) => r.kind === 'curated') as LedgerRow;
  assert.equal(closer.closes, 'mis1');
  assert.equal(closer.page, PAGE);
  assert.deepEqual(pendingMisses(f.ledger()), []);
  assert.deepEqual(f.problems(), []);
  assert.equal(f.cli('curate', 'mis1', '--reject', 'again', '--holder', holder, ...MARKS).code, 1, 'a closed miss cannot be closed twice');
});

test('a miss can be closed as out of scope with a reason; a secret shape in the reason is refused', () => {
  const f = fixture();
  f.append(missRow('mis1', 'what is the weather'));
  const holder = /holder (\w+)/.exec(f.cli('begin').out)?.[1] as string;
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  assert.equal(f.cli('curate', 'mis1', '--reject', `see ${key}`, '--holder', holder, ...MARKS).code, 1);
  assert.equal(f.cli('curate', 'mis1', '--reject', 'not a project question', '--holder', holder, ...MARKS).code, 0);
  assert.equal((f.ledger().find((r) => r.kind === 'curated') as LedgerRow).rejected, 'not a project question');
  assert.deepEqual(pendingMisses(f.ledger()), []);
});

test('verify flags a hand-written row that closes a miss without being curated', () => {
  const f = fixture();
  f.append(missRow('mis1', 'how do i rebuild the orchard index'));
  f.append({ id: 'bad1', ts: '2026-10-10T11:00:00.000Z', date: '2026-10-10', kind: 'resolved', text: 'done', closes: 'mis1' });
  assert.match(f.problems().map((p) => p.problem).join('\n'), /closes mis1, a miss row; only a composer pass handles a miss row/);
  assert.match(readFileSync(join(f.root, 'Projects', PROJECT, 'Journal', 'ledger.jsonl'), 'utf8'), /mis1/);
});
