import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerRow } from './ledger-core.ts';
import { COLD_START_MAX_CHARS, WITHHELD, coldStart, coldStartCheck, currentWorkStatement, safe } from './cold-start.ts';
import type { LibraryEntry } from './cold-start.ts';
import { main, readLibrary } from '../cold-start.ts';
import { scanText } from './library/scan.ts';

const scanTextHits = (t: string): number => scanText(t).length;

const NOW = new Date('2026-10-10T15:00:00.000Z');
const row = (o: LedgerRow): LedgerRow => ({ ts: '2026-10-10T12:00:00.000Z', date: '2026-10-10', ...o });
const FAKE_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;

/** A small ledger: two streams, one agent with a brief, a queued item, a blocked item, an ask, a note, a closed item and a secret-shaped text. */
const ROWS: LedgerRow[] = [
  row({ id: 'aaa1', kind: 'wip', stream: 'Alpha', text: 'build the widget importer', model: 'sonnet' }),
  row({ id: 'bbb1', kind: 'brief', briefs: 'aaa1', brief: 'scratch/briefs/brief-aaa1.md', report: 'scratch/briefs/report-aaa1.md' }),
  row({ id: 'aaa2', kind: 'wip', stream: 'Alpha', text: 'review the importer', queued: true }),
  row({ id: 'aaa3', kind: 'blocked', stream: 'Alpha', text: 'waiting on a vendor reply', gate: 'date:2026-10-12' }),
  row({ id: 'ccc1', kind: 'wip', stream: 'Beta', text: 'rotate the thing' }),
  row({ id: 'ccc2', kind: 'wip', stream: 'Beta', text: 'already finished work' }),
  row({ id: 'ccc3', kind: 'done', closes: 'ccc2', text: 'finished' }),
  row({ id: 'ddd1', kind: 'question', stream: 'Beta', text: 'pick the rollout order?', door: 'two-way', recommend: 'staging first' }),
  row({ id: 'eee1', kind: 'note', stream: 'Alpha', text: 'step 2 of 3 done, next: wire the CLI', ts: '2026-10-10T14:00:00.000Z' }),
  row({ id: 'fff1', kind: 'wip', stream: 'Beta', text: `use the token ${FAKE_KEY} for the call` }),
];
const LIB: LibraryEntry[] = [
  { path: 'Projects/alpha/Runbooks/ship-alpha.md', kind: 'runbook', stream: 'Alpha', status: 'current', verifiedAt: '2026-10-09' },
  { path: 'Projects/alpha/Knowledge/old.md', kind: 'gotcha', stream: 'Alpha', status: 'stale', verifiedAt: '2026-01-01' },
  { path: 'Projects/beta/Knowledge/rollout.md', kind: 'how-it-works', stream: 'beta', status: 'current', verifiedAt: '2026-10-08' },
];
const input = { rows: ROWS, registry: null, library: LIB, now: NOW };

test('the page names every open item per stream, the agent report path, the pending ask and current library pages only', () => {
  const { text, truncated, ids } = coldStart(input);
  assert.equal(truncated, false);
  assert.deepEqual([ids.inFlight, ids.blocked, ids.queued, ids.asks], [['aaa1', 'ccc1', 'fff1'], ['aaa3'], ['aaa2'], ['ddd1']]);
  for (const id of ['aaa1', 'aaa2', 'aaa3', 'ccc1', 'ddd1']) assert.ok(text.includes(`\`${id}\``), id);
  assert.match(text, /### Alpha: 1 in flight, 1 blocked, 1 queued/);
  assert.match(text, /report: scratch\/briefs\/report-aaa1\.md/);
  assert.match(text, /last note \(2026-10-10\): step 2 of 3 done/);
  assert.match(text, /rec: staging first/);
  assert.match(text, /ship-alpha\.md/);
  assert.match(text, /rollout\.md/);
  assert.doesNotMatch(text, /old\.md/);
  assert.doesNotMatch(text, /ccc2/);
});

test('a secret shape in an item is withheld and the page passes the scan', () => {
  const { text } = coldStart(input);
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(text.includes(WITHHELD));
  assert.equal(safe(`x ${FAKE_KEY}`, 80), WITHHELD);
  assert.equal(coldStartCheck(input).ok, true);
});

test('the page is bounded and keeps every in-flight, blocked and ask id as the wording shrinks', () => {
  const rows: LedgerRow[] = [];
  for (let n = 0; n < 80; n += 1) {
    rows.push(row({ id: `w${String(n).padStart(3, '0')}`, kind: 'wip', stream: n % 2 ? 'Alpha' : 'Beta', text: `task ${n} ${'detail '.repeat(30)}` }));
    rows.push(row({ id: `q${String(n).padStart(3, '0')}`, kind: 'question', stream: 'Beta', text: `question ${n} ${'detail '.repeat(30)}` }));
  }
  const page = coldStart({ ...input, rows });
  assert.ok(page.text.length <= COLD_START_MAX_CHARS, `${page.text.length}`);
  assert.ok(page.level > 0, 'a big ledger needs a shorter wording level');
  assert.equal(page.truncated, false);
  assert.equal(coldStartCheck({ ...input, rows }).ok, true);
});

test('cold-start check fails and names the ids when the page had to be cut', () => {
  const r = coldStartCheck({ ...input, maxChars: 400 });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /cut at 400/.test(p)));
  assert.ok(r.missing.length > 0 && r.missing.every((m) => /not in the current-work statement/.test(m.why)));
});

test('the statement is only the work and ask sections, so it cannot pass on a library pointer alone', () => {
  const { text } = coldStart(input);
  const s = currentWorkStatement(text);
  assert.match(s, /^## Current work/);
  assert.match(s, /## Decisions pending/);
  assert.doesNotMatch(s, /## How to work/);
  assert.equal(currentWorkStatement('no sections'), '');
});

test('an empty ledger still states that nothing is in flight', () => {
  const r = coldStartCheck({ ...input, rows: [] });
  assert.equal(r.ok, true);
  assert.match(r.statement, /Nothing in flight, blocked or queued\./);
});

test('CLI: generate prints the page, check passes on a fixture and fails (exit 1) when the cap cuts an in-flight id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cold-start-'));
  try {
    const ledger = join(dir, 'ledger.jsonl');
    writeFileSync(ledger, `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const lib = join(dir, 'vault');
    mkdirSync(join(lib, 'Projects', 'alpha', 'Runbooks'), { recursive: true });
    writeFileSync(join(lib, 'Projects', 'alpha', 'Runbooks', 'ship-alpha.md'), '---\ntype: library\nkind: runbook\nstream: Alpha\nstatus: current\nverified-at: 2026-10-09\n---\nbody\n');
    writeFileSync(join(lib, 'Projects', 'alpha', 'Runbooks', 'plain.md'), '---\ntype: note\nstream: Alpha\n---\n');
    assert.deepEqual(readLibrary(lib).map((p) => p.path), [join('Projects', 'alpha', 'Runbooks', 'ship-alpha.md')]);
    const log = console.log; const err = console.error; const out: string[] = [];
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); }; console.error = () => {};
    try {
      assert.equal(main(['check', '--ledger', ledger, '--library', lib], NOW), 0);
      assert.match(out.join('\n'), /`aaa1`/);
      assert.equal(main(['check', '--ledger', ledger, '--library', lib, '--max', '300'], NOW), 1);
      assert.equal(main(['check', '--ledger', join(dir, 'nope.jsonl')], NOW), 2);
      assert.equal(main(['bogus'], NOW), 2);
    } finally { console.log = log; console.error = err; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a library date written as date@sha shows the full date', () => {
  const library = [{ ...(LIB[0] as LibraryEntry), verifiedAt: '2026-10-09@6fa5f6c' }];
  const { text } = coldStart({ ...input, library });
  assert.match(text, /verified 2026-10-09\)/);
  assert.doesNotMatch(text, /2026-10-0…/);
});

test('a ledger row with a numeric ts does not break the page and the page names it', () => {
  const rows = [
    ...ROWS,
    { ...row({ id: 'ggg1', kind: 'note', stream: 'Alpha', text: 'odd row' }), ts: 1760000000 as unknown as string },
    { ...row({ id: 'ggg2', kind: 'question', stream: 'Beta', text: 'odd ask?' }), ts: 1760000001 as unknown as string },
  ];
  const { text } = coldStart({ ...input, rows });
  assert.match(text, /`aaa1`/);
  assert.match(text, /`ggg2`/);
  assert.match(text, /2 ledger row\(s\) have a ts that is not text/);
});

test('a secret-shaped stream name or id is withheld on the page, not printed', () => {
  const tokenStream = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6'}`;
  const rows = [
    ...ROWS,
    row({ id: 'hhh1', kind: 'wip', stream: tokenStream, text: 'work in an odd stream' }),
    row({ id: 'hhh2', kind: 'question', stream: tokenStream, text: 'odd stream ask?' }),
    row({ id: FAKE_KEY, kind: 'wip', stream: 'Alpha', text: 'work with an odd id' }),
  ];
  const { text } = coldStart({ ...input, rows });
  assert.ok(!text.includes(tokenStream));
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(text.includes(`### ${WITHHELD}:`));
  assert.ok(text.includes(`[${WITHHELD}]`));
  assert.equal(scanTextHits(text), 0);
});

test('generate drops the How to work section before cutting, and a forced cut names every id it dropped', () => {
  let fit = 100;
  while (coldStart({ ...input, maxChars: fit }).truncated) fit += 5;
  const smallest = coldStart({ ...input, maxChars: fit });
  assert.doesNotMatch(smallest.text, /## How to work/);
  assert.match(smallest.text, /`aaa1`[\s\S]*`ddd1`/);
  assert.match(coldStart(input).text, /## How to work/);
  const cut = coldStart({ ...input, maxChars: fit - 120 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= fit - 120, `${cut.text.length}`);
  for (const id of ['aaa1', 'aaa3', 'ddd1', 'ccc1', 'fff1']) assert.ok(cut.text.includes(id), `${id} neither shown nor named`);
  assert.match(cut.text, /open ids not shown: /);
});

test('the cut line names exactly the ids missing from the shown lines, and a big ledger loses no id silently', () => {
  const rows: LedgerRow[] = [];
  for (let n = 0; n < 400; n += 1) rows.push(row({ id: `z${String(n).padStart(3, '0')}`, kind: 'question', stream: 'Beta', text: `question ${n}` }));
  const page = coldStart({ ...input, rows, maxChars: 3000 });
  assert.equal(page.truncated, true);
  assert.ok(page.text.length <= 3000);
  for (const id of page.ids.asks) assert.ok(page.text.includes(id), `${id} neither shown nor named`);
  assert.equal(coldStartCheck({ ...input, rows, maxChars: 3000 }).ok, false);
});
