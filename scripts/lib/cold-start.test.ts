import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerRow } from './ledger-core.ts';
import { COLD_START_MAX_CHARS, WITHHELD, coldStart, coldStartCheck, currentWorkStatement, safe } from './cold-start.ts';
import type { LibraryEntry } from './cold-start.ts';
import { main, readLibrary } from '../cold-start.ts';
import { activeProjects, prioritiesDir, readProjectEntry, writeProjectPriorities } from './status-page/project-priorities.ts';
import type { Homes } from './home/config.ts';
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
    mkdirSync(join(lib, 'Projects', 'beta', 'Knowledge'), { recursive: true });
    writeFileSync(join(lib, 'Projects', 'beta', 'Knowledge', 'rollout.md'), '---\ntype: library\nkind: how-it-works\nstream: Beta\nstatus: current\nverified-at: 2026-10-08\n---\nbody\n');
    mkdirSync(join(lib, 'Projects', 'proj-a'), { recursive: true });
    const status = join(dir, 'status');
    mkdirSync(status, { recursive: true });
    writeFileSync(join(status, 'stream-homes.json'), JSON.stringify({ version: 1, streams: { Alpha: { projects: ['proj-a'] }, Beta: { projects: ['proj-a'] } } }));
    writeProjectPriorities(lib, 'proj-a', '2026-10-09', { project: 'proj-a', date: '2026-10-09', carriedFrom: '', writtenBy: 'priorities set', today: [{ text: 'x' }], carried: [], next: [] });
    assert.deepEqual(readLibrary(lib).map((p) => p.path), [join('Projects', 'alpha', 'Runbooks', 'ship-alpha.md'), join('Projects', 'beta', 'Knowledge', 'rollout.md')]);
    const log = console.log; const err = console.error; const out: string[] = [];
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); }; console.error = () => {};
    try {
      assert.equal(main(['check', '--ledger', ledger, '--library', lib, '--status-dir', status], NOW), 0);
      assert.match(out.join('\n'), /`aaa1`/);
      assert.equal(main(['check', '--ledger', ledger, '--library', lib, '--status-dir', status, '--max', '300'], NOW), 1);
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

test('a huge ledger under a tiny cap is cut in linear time, and the closing line accounts for every open id', { timeout: 5000 }, () => {
  const rows: LedgerRow[] = [];
  for (let n = 0; n < 2000; n += 1) rows.push(row({ id: `y${String(n).padStart(4, '0')}`, kind: 'question', stream: 'Beta', text: `question ${n}` }));
  const page = coldStart({ ...input, rows, maxChars: 600 });
  assert.equal(page.truncated, true);
  assert.ok(page.text.length <= 600, `${page.text.length}`);
  const closing = page.text.split('\n').pop() ?? '';
  const more = Number(closing.match(/ … and (\d+) more open ids not named$/)?.[1] ?? 0);
  const named = closing.replace(/^.*open ids not shown: /, '').replace(/ … and \d+ more open ids not named$/, '').split(' ').filter(Boolean).length;
  assert.ok(more > 0, closing.slice(0, 120));
  const shownOnPage = page.ids.asks.filter((id) => page.text.split('\n').slice(0, -1).some((l) => l.includes(`\`${id}\``))).length;
  assert.equal(named + more + shownOnPage, page.ids.asks.length, 'every open id is shown, named or counted');
});

test('check output never prints a secret-shaped id: the MISSING line shows the withheld marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cold-secret-'));
  const log = console.log; const err = console.error; const out: string[] = []; const errs: string[] = [];
  try {
    const ledger = join(dir, 'ledger.jsonl');
    writeFileSync(ledger, `${JSON.stringify(row({ id: FAKE_KEY, kind: 'question', stream: 'Beta', text: 'which one?' }))}\n`);
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); }; console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    assert.equal(main(['check', '--ledger', ledger, '--library', join(dir, 'none'), '--max', '300'], NOW), 1);
  } finally { console.log = log; console.error = err; rmSync(dir, { recursive: true, force: true }); }
  assert.ok(![...out, ...errs].join('\n').includes(FAKE_KEY), 'neither stream carries the value');
  assert.match(errs.join('\n'), /MISSING `\[withheld: secret shape\]`/);
});

/** A vault with two projects: one whose CONTEXT.md has Now and Next and a priorities file from the day before, one with neither. */
function projectVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'cold-proj-'));
  mkdirSync(join(v, 'Projects', 'proj-a'), { recursive: true });
  mkdirSync(join(v, 'Projects', 'proj-b'), { recursive: true });
  writeFileSync(join(v, 'Projects', 'proj-a', 'CONTEXT.md'), `# A\n\n## Now\n- wiring the importer\n- ${FAKE_KEY} leaked here\n\n## Next\n- ship the importer\n\n## Other\nignored\n`);
  writeProjectPriorities(v, 'proj-a', '2026-10-09', { project: 'proj-a', date: '2026-10-09', carriedFrom: '2026-10-08', writtenBy: 'priorities set', today: [{ text: 'importer', stream: 'Alpha' }], carried: [{ item: { text: 'old' }, status: '0 done, 0 in flight, 0 queued, 0 blocked' }], next: [] });
  return v;
}
const homes: Homes = { found: true, warnings: [], streams: { Alpha: { projects: ['proj-a'], epics: [], exclude: [], done: {}, docs: [], runbooks: [], pins: [] }, Beta: { projects: ['proj-b'], epics: [], exclude: [], done: {}, docs: [], runbooks: [], pins: [] } } };

test('the Projects section points at each active project\'s Now, Next and priorities files, says what is missing and withholds a secret-shaped line', () => {
  const v = projectVault();
  try {
    const projects = activeProjects({ vault: v, rows: ROWS, registry: null, homes, repoStreams: {}, containerProject: 'dev-env' });
    assert.deepEqual(projects.map((p) => p.project).sort(), ['proj-a', 'proj-b']);
    const page = coldStart({ ...input, projects, today: '2026-10-12' });
    assert.match(page.text, /\n## Projects\n/);
    assert.match(page.text, /### proj-a \(Alpha\)\n- Now: wiring the importer\n- Now: \[withheld: secret shape\]\n- Next: ship the importer\n- Priorities: no priorities file since 2026-10-09; newest is Projects\/proj-a\/Status\/priorities\/2026-10-09\.md \(2026-10-09, 1 today, 1 carried\)/);
    assert.match(page.text, /### proj-b \(Beta\)\n- Now: no `## Now` section in Projects\/proj-b\/CONTEXT\.md\n- Next: no `## Next` section in Projects\/proj-b\/CONTEXT\.md\n- Priorities: no priorities file\n/);
    assert.ok(!page.text.includes(FAKE_KEY));
    assert.ok(!currentWorkStatement(page.text).includes('## Projects'), 'the statement is still work and asks only');
    assert.equal(coldStart({ ...input, projects: [], today: '2026-10-12' }).text.includes('## Projects'), false);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a tight cap drops the Projects Now and Next text first and keeps the priorities pointers', () => {
  const v = projectVault();
  try {
    const projects = activeProjects({ vault: v, rows: ROWS, registry: null, homes, repoStreams: {}, containerProject: 'dev-env' });
    let max = coldStart({ ...input, projects }).text.length;
    let page = coldStart({ ...input, projects, maxChars: max });
    while (!page.truncated && /- Now:/.test(page.text) && max > 0) { max -= 5; page = coldStart({ ...input, projects, maxChars: max }); }
    const kept = page;
    assert.ok(!kept.truncated, 'the Now text goes before any line is cut');
    assert.doesNotMatch(kept.text, /- Now:/);
    assert.doesNotMatch(kept.text, /## How to work/);
    assert.match(kept.text, /- Priorities: .*2026-10-09\.md \(2026-10-09, 1 today, 1 carried\)/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('readProjectEntry reads the newest two priorities files and a missing CONTEXT.md as missing sections', () => {
  const v = projectVault();
  try {
    writeProjectPriorities(v, 'proj-a', '2026-10-12', { project: 'proj-a', date: '2026-10-12', carriedFrom: '', writtenBy: 'roll-maintenance', today: [], carried: [], next: [] });
    const a = readProjectEntry(v, 'proj-a', ['Alpha']);
    assert.deepEqual([a.priorities?.date, a.priorities?.today, a.previous?.date], ['2026-10-12', 0, '2026-10-09']);
    assert.deepEqual([a.now, a.next], [['wiring the importer', `${FAKE_KEY} leaked here`], ['ship the importer']]);
    const b = readProjectEntry(v, 'proj-b', []);
    assert.deepEqual([b.now, b.next, b.priorities, b.previous], [null, null, null, null]);
    assert.ok(prioritiesDir(v, 'proj-a').endsWith(join('proj-a', 'Status', 'priorities')));
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('--budget makes check fail when the page is over it, and generate honours it as a cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cold-budget-'));
  const log = console.log; const err = console.error; const errs: string[] = [];
  try {
    const ledger = join(dir, 'ledger.jsonl');
    writeFileSync(ledger, `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`);
    console.log = () => {}; console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    assert.equal(main(['check', '--ledger', ledger, '--library', join(dir, 'none'), '--status-dir', join(dir, 'status'), '--budget', '10'], NOW), 1);
    assert.match(errs.join('\n'), /PROBLEM: page is about \d+ tokens, over the budget of 10/);
    errs.length = 0;
    main(['check', '--ledger', ledger, '--library', join(dir, 'none'), '--status-dir', join(dir, 'status')], NOW);
    assert.doesNotMatch(errs.join('\n'), /over the budget/, 'the default budget is far above this page');
    assert.equal(main(['check', '--ledger', ledger, '--budget', '0'], NOW), 2);
  } finally { console.log = log; console.error = err; rmSync(dir, { recursive: true, force: true }); }
});

test('check fails for an active stream with no carry-over or no how-to, passes once both exist, and a Monday counts Friday', () => {
  const rows: LedgerRow[] = [row({ id: 'k1', kind: 'wip', stream: 'Alpha', text: 'work' })];
  const entry = (date: string | null) => ({ project: 'proj-a', streams: ['Alpha'], contextPath: 'Projects/proj-a/CONTEXT.md', now: ['n'], next: ['x'], priorities: date ? { date, path: `Projects/proj-a/Status/priorities/${date}.md`, today: 1, carried: 0 } : null, previous: null });
  const page = (projects: ReturnType<typeof entry>[], library: LibraryEntry[], today: string) => coldStartCheck({ rows, registry: null, library, now: NOW, projects, today });
  const bare = page([entry(null)], [], '2026-10-12');
  assert.equal(bare.ok, false);
  assert.deepEqual(bare.problems, ['stream Alpha: no carry-over (a priorities file dated 2026-10-09 or later in one of its projects)', 'stream Alpha: no how-to (no current library page)']);
  assert.equal(page([entry('2026-10-09')], [LIB[0] as LibraryEntry], '2026-10-12').ok, true, 'on a Monday, Friday counts');
  assert.equal(page([entry('2026-10-08')], [LIB[0] as LibraryEntry], '2026-10-12').ok, false, 'Thursday is too old for a Monday');
  assert.equal(page([entry('2026-10-11')], [LIB[0] as LibraryEntry], '2026-10-12').ok, true, 'yesterday counts');
  assert.equal(page([entry('2026-10-08')], [LIB[0] as LibraryEntry], '2026-10-09').ok, true, 'on a Friday, Thursday counts');
  assert.equal(coldStartCheck({ rows, registry: null, library: [], now: NOW }).ok, true, 'without projects the stream checks are skipped');
});
