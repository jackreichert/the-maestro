// Run: node --test scripts/standing.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROWS, STANDING_FILE, appendEvent, conditionLines, conditionStates, isRoutine, readEvents, standingBlock, standingState, validRow } from './lib/standing.ts';
import type { CheckContext, StandingEvent } from './lib/standing.ts';
import { commitmentLines } from './lib/journal/handoff.ts';
import { addWatch } from './lib/watch-registry.ts';

const NOON = Date.parse('2026-10-06T12:00:00Z');
const HOUR = 3600_000;
const healthy = (over: Partial<CheckContext> = {}): CheckContext => ({
  now: NOON, loopPid: () => 4242, watches: () => ({ live: 3, expired: [] }), queue: () => ({ inflight: 1, queued: 2 }), pendingTransitions: () => [], ...over,
});
const ran = (id: string, hoursAgo: number): StandingEvent => ({ op: 'ran', id, evidence: 'did it', at: new Date(NOON - hoursAgo * HOUR).toISOString() });
const statusOf = (events: StandingEvent[], ctx: CheckContext, id: string) => standingState(events, ctx).find((s) => s.row.id === id)?.status;

test('the built-in rows cover the pickups the ticket names, each enforced by a check or a cadence', () => {
  assert.deepEqual(DEFAULT_ROWS.map((r) => r.id), ['loop-alive', 'chain-next', 'merge-sweep', 'branch-sweep', 'epic-briefs', 'tracker-reconcile']);
  for (const r of DEFAULT_ROWS) assert.equal(validRow(r), null, r.id);
});

test('checked rows take their status from the machine, not from anyone saying they are done', () => {
  const fresh = [ran('loop-alive', 0), ran('chain-next', 0), ran('tracker-reconcile', 0)];
  assert.equal(statusOf(fresh, healthy({ loopPid: () => null }), 'loop-alive'), 'failing');
  assert.equal(statusOf(fresh, healthy({ watches: () => ({ live: 0, expired: [] }) }), 'loop-alive'), 'failing');
  assert.equal(statusOf(fresh, healthy({ watches: () => ({ live: 2, expired: ['prs'] }) }), 'loop-alive'), 'failing');
  assert.equal(statusOf([], healthy(), 'loop-alive'), 'ok', 'a healthy loop needs no ran row');
  assert.equal(statusOf(fresh, healthy({ queue: () => ({ inflight: 0, queued: 3 }) }), 'chain-next'), 'failing');
  assert.equal(statusOf(fresh, healthy({ queue: () => ({ inflight: 0, queued: 0 }) }), 'chain-next'), 'ok');
  assert.equal(statusOf(fresh, healthy({ pendingTransitions: () => ['ABC-1'] }), 'tracker-reconcile'), 'failing');
});

test('the epic-briefs row fails while an epic touched today owes a brief or a note, and says what', () => {
  assert.equal(statusOf([], healthy(), 'epic-briefs'), 'ok', 'no vault configured: nothing to check, and it says so');
  const owing = healthy({ epicBriefs: () => ({ epics: 2, failures: ['e-1 brief is stale: 1 ticket updated after 2026-10-05.', 'a note names no ticket.'] }) });
  const row = standingState([ran('epic-briefs', 0)], owing).find((x) => x.row.id === 'epic-briefs');
  assert.equal(row?.status, 'failing', 'a recorded run does not clear a failing check');
  assert.match(row?.detail ?? '', /2 to fix, first: e-1 brief is stale/);
  assert.equal(statusOf([], healthy({ epicBriefs: () => ({ epics: 1, failures: [] }) }), 'epic-briefs'), 'ok');
});

test('a check that throws reads as failing with the reason, and takes nothing else down', () => {
  const states = standingState([], healthy({ loopPid: () => { throw new Error('lock unreadable'); } }));
  const loop = states.find((s) => s.row.id === 'loop-alive');
  assert.equal(loop?.status, 'failing');
  assert.match(loop?.detail ?? '', /check threw: lock unreadable/);
  assert.equal(states.length, DEFAULT_ROWS.length);
});

test('cadence rows: never ran and stale are overdue, a recent run is ok', () => {
  assert.equal(statusOf([], healthy(), 'merge-sweep'), 'overdue');
  assert.equal(statusOf([ran('merge-sweep', 23)], healthy(), 'merge-sweep'), 'ok');
  assert.equal(statusOf([ran('merge-sweep', 25)], healthy(), 'merge-sweep'), 'overdue');
  const bad = standingState([{ op: 'ran', id: 'merge-sweep', evidence: 'x', at: 'not a date' }], healthy()).find((s) => s.row.id === 'merge-sweep');
  assert.equal(bad?.status, 'overdue', 'an unreadable timestamp is not evidence');
});

test('add replaces a built-in row and forgets its runs; retire removes a row', () => {
  const events: StandingEvent[] = [ran('merge-sweep', 1), { op: 'add', at: new Date(NOON).toISOString(), id: 'merge-sweep', trigger: 't', action: 'a', who: 'w', everyHours: 2 }];
  const row = standingState(events, healthy()).find((s) => s.row.id === 'merge-sweep');
  assert.equal(row?.row.everyHours, 2);
  assert.equal(row?.status, 'overdue');
  assert.equal(standingState([...events, { op: 'retire', at: '2026-10-06T12:00:00Z', id: 'merge-sweep' }], healthy()).some((s) => s.row.id === 'merge-sweep'), false);
});

test('validRow refuses a row nothing would ever flag, an unknown check, a bad cadence, a bad id and blanks', () => {
  const ok = { id: 'x', trigger: 't', action: 'a', who: 'w', everyHours: 1 };
  assert.equal(validRow(ok), null);
  assert.match(validRow({ ...ok, everyHours: undefined }) ?? '', /needs a runtime check/);
  assert.match(validRow({ ...ok, check: 'nope' }) ?? '', /unknown check "nope"/);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.match(validRow({ ...ok, everyHours: bad }) ?? '', /positive number/, String(bad));
  assert.match(validRow({ ...ok, id: 'has space' }) ?? '', /id must match/);
  assert.match(validRow({ ...ok, trigger: '  ' }) ?? '', /trigger, an action and a who/);
});

test('the store skips corrupt lines and rows that would not validate, and a missing file is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'standing-test-'));
  const file = join(dir, STANDING_FILE);
  assert.deepEqual(readEvents(file), []);
  appendEvent(file, { op: 'ran', id: 'a', evidence: 'e', at: '2026-10-06T00:00:00Z' });
  appendFileSync(file, `not json\n{"op":"add","id":"b","trigger":"t","action":"a","who":"w","at":"x"}\n{"op":"add","id":"c","trigger":"t","action":"a","who":"w","check":"nope","at":"x"}\n{"op":"ran","id":"d","at":"x"}\n[]\nnull\n`);
  assert.deepEqual(readEvents(file).map((e) => e.id), ['a']);
});

test('standingBlock: silent when everything is ok, only rows needing attention for prime, every row for handoff, capped with a count', () => {
  const all = standingState([ran('merge-sweep', 1), ran('branch-sweep', 1)], healthy());
  assert.deepEqual(standingBlock(all), []);
  assert.equal(standingBlock(all, { all: true }).length, 1 + DEFAULT_ROWS.length);
  const broken = standingState([], healthy({ loopPid: () => null }));
  const prime = standingBlock(broken, { max: 2 });
  assert.match(prime[0], /Standing pickups \(3 need attention, 6 total\)/);
  assert.equal(prime.length, 1 + 2);
  assert.match(prime[2], /… \+2 more/);
  assert.equal(standingBlock(broken).length, 1 + 3);
  assert.ok(standingBlock(broken).every((l) => !l.includes('\n')));
});

// ── the CLI ────────────────────────────────────────────────────────────────

const JOURNAL = new URL('./journal.ts', import.meta.url).pathname;
function cli(vault: string, events: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [JOURNAL, ...args, '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8', cwd: tmpdir(),
    env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', VAULT_ROOT: '', MAESTRO_EVENT_DIR: events, MAESTRO_LAUNCH_AGENTS_DIR: join(events, 'LaunchAgents'), MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '', MAESTRO_PROJECTS_DIR: tmpdir() },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const standingFile = (vault: string) => join(vault, 'Projects', 'test-proj', 'Journal', STANDING_FILE);
const setup = () => ({ vault: mkdtempSync(join(tmpdir(), 'standing-vault-')), events: mkdtempSync(join(tmpdir(), 'standing-events-')) });
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro'];

test('cli: list shows every built-in row; check exits 1 while any needs attention', () => {
  const { vault, events } = setup();
  const list = cli(vault, events, 'standing', 'list');
  assert.equal(list.code, 0, list.err);
  for (const r of DEFAULT_ROWS) assert.match(list.out, new RegExp(`${r.id}:`));
  const check = cli(vault, events, 'standing', 'check');
  assert.equal(check.code, 1);
  assert.match(check.out, /FAILING loop-alive: .*no event loop holds the lock/);
  assert.match(check.out, /OVERDUE merge-sweep: .*never ran/);
});

test('cli: done refuses a checked row whose check fails, and writes nothing', () => {
  const { vault, events } = setup();
  const r = cli(vault, events, 'standing', 'done', 'loop-alive', '--evidence', 'trust me');
  assert.equal(r.code, 1);
  assert.match(r.err, /not done: its check says no event loop holds the lock/);
  assert.equal(existsSync(standingFile(vault)), false);
});

test('cli: done on an unchecked row needs evidence; with it the row turns ok and records the evidence', () => {
  const { vault, events } = setup();
  const refused = cli(vault, events, 'standing', 'done', 'merge-sweep');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /needs --evidence/);
  assert.equal(existsSync(standingFile(vault)), false);
  const done = cli(vault, events, 'standing', 'done', 'merge-sweep', '--evidence', 'swept PRs #1 and #2');
  assert.equal(done.code, 0, done.err);
  assert.match(readFileSync(standingFile(vault), 'utf8'), /"evidence":"swept PRs #1 and #2"/);
  assert.match(cli(vault, events, 'standing', 'list').out, /^ok      merge-sweep:/m);
  assert.equal(cli(vault, events, 'standing', 'done', 'no-such-row', '--evidence', 'x').code, 1);
});

test('cli: a live loop with live watches makes loop-alive pass, and done records the check result as evidence', () => {
  const { vault, events } = setup();
  mkdirSync(events, { recursive: true });
  writeFileSync(join(events, 'loop.lock'), String(process.pid));
  addWatch(events, { id: 'w', type: 't', target: 'x' });
  assert.match(cli(vault, events, 'standing', 'list').out, /^ok      loop-alive:/m);
  const done = cli(vault, events, 'standing', 'done', 'loop-alive');
  assert.equal(done.code, 0, done.err);
  assert.match(readFileSync(standingFile(vault), 'utf8'), /loop pid \d+ running, 1 watch\(es\) live/);
});

test('cli: add validates before writing; a good row shows up, retire removes it', () => {
  const { vault, events } = setup();
  const bad = cli(vault, events, 'standing', 'add', 'x', '--trigger', 't', '--action', 'a', '--who', 'w');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /needs a runtime check/);
  assert.equal(cli(vault, events, 'standing', 'add', 'x', '--trigger', 't', '--action', 'a', '--who', 'w', '--check', 'nope').code, 1);
  assert.equal(cli(vault, events, 'standing', 'add', 'x', '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', 'abc').code, 1);
  assert.equal(existsSync(standingFile(vault)), false);
  assert.equal(cli(vault, events, 'standing', 'add', 'water', '--trigger', 'monday', '--action', 'water the plants', '--who', 'me', '--every-hours', '168').code, 0);
  assert.match(cli(vault, events, 'standing', 'list').out, /OVERDUE water: water the plants/);
  assert.equal(cli(vault, events, 'standing', 'retire', 'water').code, 0);
  assert.doesNotMatch(cli(vault, events, 'standing', 'list').out, /water the plants/);
  assert.equal(cli(vault, events, 'standing', 'retire', 'water').code, 1);
});

test('cli: --dry-run writes nothing', () => {
  const { vault, events } = setup();
  assert.equal(cli(vault, events, 'standing', 'done', 'merge-sweep', '--evidence', 'x', '--dry-run').code, 0);
  assert.equal(cli(vault, events, 'standing', 'add', 'x', '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', '1', '--dry-run').code, 0);
  assert.equal(existsSync(standingFile(vault)), false);
});

test('cli: prime carries the rows needing attention inside its 40 lines; handoff carries every row', () => {
  const { vault, events } = setup();
  for (let i = 0; i < 30; i += 1) assert.equal(cli(vault, events, 'log', `open item number ${i}`, '--kind', 'wip', '--stream', 'S', '--new-stream', ...MARK).code, 0);
  const prime = cli(vault, events, 'prime');
  assert.equal(prime.code, 0, prime.err);
  assert.match(prime.out, /^Standing pickups \(\d need attention, 6 total\)/m);
  assert.match(prime.out, /FAILING loop-alive/);
  assert.ok(prime.out.trimEnd().split('\n').length <= 40);
  const handoff = cli(vault, events, 'handoff', '--stream', 'S', '--dry-run', '--no-worktree-sweep');
  assert.equal(handoff.code, 0, handoff.err);
  assert.match(handoff.out, /## Standing pickups/);
  for (const r of DEFAULT_ROWS) assert.match(handoff.out, new RegExp(`${r.id}:`));
  cli(vault, events, 'standing', 'done', 'merge-sweep', '--evidence', 'x');
  assert.match(cli(vault, events, 'handoff', '--stream', 'S', '--dry-run', '--no-worktree-sweep').out, /ok      merge-sweep:/, 'handoff keeps ok rows, prime drops them');
  assert.doesNotMatch(cli(vault, events, 'prime').out, /merge-sweep/);
});

// ── conditions: non-routine pickups tied to a future action ────────────────

const added = (id: string, trigger: string, hours = 24): StandingEvent => ({ op: 'add', id, trigger, action: `act on ${id}`, who: 'orchestrator', everyHours: hours, at: new Date(NOON - 100 * HOUR).toISOString() });

test('conditions are the rows that are not built in, overdue ones first; built-in rows are routine', () => {
  const states = standingState([added('proxy-first', 'before prod'), added('docs-later', 'when docs merge'), ran('proxy-first', 1)], healthy());
  assert.ok(DEFAULT_ROWS.every(isRoutine));
  assert.deepEqual(conditionStates(states).map((s) => s.row.id), ['docs-later', 'proxy-first'], 'overdue docs-later before ok proxy-first');
  assert.deepEqual(conditionStates(standingState([], healthy())), [], 'a fresh install has none');
});

const LETTERS = 'abcdefghij';

test('conditionLines: id, status, due time and kind only, capped with a +N more pointer to standing list', () => {
  const events = Array.from({ length: 9 }, (_, i) => added(`cond-${LETTERS[i]}`, `before launch ${i}`));
  const lines = conditionLines(standingState(events, healthy()), 4);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Condition cond-a [OVERDUE] standing pickup, due now');
  assert.equal(lines[3], '… +6 more, journal.ts standing list');
  assert.deepEqual(conditionLines(standingState([], healthy())), []);
  const fresh = conditionLines(standingState([added('docs-later', 'when docs merge'), ran('docs-later', 1)], healthy()));
  assert.match(fresh[0], /^Condition docs-later \[due\] standing pickup, due \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
});

test('standing ids that could carry typed text print as a placeholder; text is never printed', () => {
  const states = standingState([added('db-Tr0ub4dor.3', 'before prod: use Bruno-1987!'), { op: 'add', id: 'smtp', trigger: 'x', action: 'SMTP_PASS fakeHunter2 admin / hunter2', who: 'orchestrator', everyHours: 24, at: new Date(NOON - 100 * HOUR).toISOString() }], healthy());
  const out = [...conditionLines(states), ...commitmentLines(states, [])].join('\n');
  assert.match(out, /Condition \[id withheld\] \[OVERDUE\] standing pickup, due now/);
  assert.match(out, /standing `\[id withheld\]` \[overdue\] kind: standing pickup, due now/);
  assert.doesNotMatch(out, /Tr0ub4dor|Bruno|SMTP_PASS|hunter2|Hunter2|before prod/i);
});

test('commitmentLines: open decisions by id and kind, with a date only from a strict date gate; text is never printed', () => {
  const decision = (id: string, text: string, gate?: string) => ({ id, kind: 'decision', pending: true, text, gate, closedBy: null, state: undefined });
  const out = commitmentLines([], [decision('k1x9', 'keep wifi on Mithril-2026! for the booth?', 'date:2026-10-20'), decision('k2y8', 'ship admin / hunter2?', 'gh:pr:x/Hunter2#1'), decision('Hunter2-1', 'x')]).join('\n');
  assert.match(out, /- `k1x9` \[open\] kind: decision, due 2026-10-20/);
  assert.match(out, /- `k2y8` \[open\] kind: decision, due when decided/);
  assert.match(out, /- `\[id withheld\]` \[open\] kind: decision/);
  assert.doesNotMatch(out, /Mithril|hunter2|Hunter2|wifi/i);
});

test('cli: standing add refuses an id with digits or punctuation, and accepts lowercase words', () => {
  const { vault, events } = setup();
  for (const id of ['db-Tr0ub4dor.3', 'Hunter2-1', 'a1', 'proxy_first', 'Proxy', 'a-b-c-d-e-f-g']) {
    const r = cli(vault, events, 'standing', 'add', id, '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', '1');
    assert.equal(r.code, 1, id);
    assert.match(r.err, /lowercase words joined by hyphens/, id);
  }
  assert.equal(existsSync(standingFile(vault)), false);
  assert.equal(cli(vault, events, 'standing', 'add', 'proxy-first', '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', '1').code, 0);
});

test('cli: prime prints conditions first, once each, inside its 40 lines; handoff has the required section', () => {
  const { vault, events } = setup();
  for (let i = 0; i < 30; i += 1) assert.equal(cli(vault, events, 'log', `open item number ${i}`, '--kind', 'wip', '--stream', 'S', '--new-stream', ...MARK).code, 0);
  assert.equal(cli(vault, events, 'standing', 'add', 'proxy-first', '--trigger', 'before prod, Bruno-1987!', '--action', 'work out the proxy, admin / hunter2', '--who', 'orchestrator', '--every-hours', '24').code, 0);
  assert.equal(cli(vault, events, 'ask', 'ship the proxy with Mithril-2026! on Friday?', '--kind', 'decision', '--stream', 'S', ...MARK).code, 0);
  const prime = cli(vault, events, 'prime');
  assert.equal(prime.code, 0, prime.err);
  const lines = prime.out.trimEnd().split('\n');
  assert.equal(lines[0], 'Condition proxy-first [OVERDUE] standing pickup, due now');
  assert.equal(prime.out.match(/proxy-first/g)?.length, 1, 'not repeated in the standing block');
  assert.ok(lines.length <= 40);
  const handoff = cli(vault, events, 'handoff', '--stream', 'S', '--dry-run', '--no-worktree-sweep').out;
  const section = handoff.split('## Commitments and conditions')[1]?.split('\n## ')[0] ?? '';
  assert.match(section, /standing `proxy-first` \[overdue\] kind: standing pickup, due now/);
  assert.match(section, /`\w{4}` \[open\] kind: decision, due when decided/);
  assert.doesNotMatch(section, /merge-sweep/, 'built-in routine rows stay in Standing pickups');
  assert.doesNotMatch(`${lines.slice(0, 1).join('')}${section}`, /Bruno|hunter2|Mithril|work out the proxy/i, 'no typed text in prime conditions or the section');
});

test('cli: with no conditions and no open decisions the section says _none_ and prime prints no Condition line', () => {
  const { vault, events } = setup();
  assert.equal(cli(vault, events, 'log', 'one item', '--kind', 'wip', '--stream', 'S', '--new-stream', ...MARK).code, 0);
  const handoff = cli(vault, events, 'handoff', '--stream', 'S', '--dry-run', '--no-worktree-sweep').out;
  assert.match(handoff, /## Commitments and conditions\n[\s\S]*\n_none_\n/);
  assert.doesNotMatch(cli(vault, events, 'prime').out, /^Condition /m);
});

test('cli: many conditions are truncated in prime with a pointer, and the cap holds', () => {
  const { vault, events } = setup();
  for (let i = 0; i < 9; i += 1) assert.equal(cli(vault, events, 'standing', 'add', `cond-${LETTERS[i]}`, '--trigger', `before launch ${i}`, '--action', `do ${i}`, '--who', 'orchestrator', '--every-hours', '24').code, 0);
  const lines = cli(vault, events, 'prime').out.trimEnd().split('\n');
  assert.equal(lines.filter((l) => l.startsWith('Condition ')).length, 5);
  assert.ok(lines.includes('… +4 more, journal.ts standing list'));
  assert.ok(lines.length <= 40);
});

test('cli: a delta handoff carries a condition added after the full handoff, which no other section would show', () => {
  const { vault, events } = setup();
  const day = new Date().toISOString().slice(0, 10);
  const journal = join(vault, 'Projects', 'test-proj', 'Journal');
  assert.equal(cli(vault, events, 'log', 'one item', '--kind', 'wip', '--stream', 'S', '--new-stream', ...MARK).code, 0);
  assert.equal(cli(vault, events, 'handoff', '--stream', 'S', '--delta', '--no-worktree-sweep').code, 0);
  assert.doesNotMatch(readFileSync(join(journal, `HANDOFF-${day}-S.md`), 'utf8'), /standing `late-rule`/);
  assert.equal(cli(vault, events, 'standing', 'add', 'late-rule', '--trigger', 'before launch', '--action', 'check the demo proxy', '--who', 'orchestrator', '--every-hours', '24').code, 0);
  assert.equal(cli(vault, events, 'handoff', '--stream', 'S', '--delta', '--no-worktree-sweep').code, 0);
  const delta = readFileSync(join(journal, `HANDOFF-${day}b-S.md`), 'utf8');
  assert.match(delta, /## Commitments and conditions[^]*standing `late-rule` \[overdue\] kind: standing pickup, due now/);
});

test('overriding a built-in id makes it a condition, so its typed text never reaches prime', () => {
  const { vault, events } = setup();
  assert.equal(cli(vault, events, 'log', 'one item', '--kind', 'wip', '--stream', 'S', '--new-stream', ...MARK).code, 0);
  assert.equal(cli(vault, events, 'standing', 'add', 'merge-sweep', '--trigger', 'pw is hunter2', '--action', 'use sk-FAKEKEY', '--who', 'agent', '--every-hours', '24').code, 0);
  const prime = cli(vault, events, 'prime').out;
  assert.doesNotMatch(prime, /hunter2|sk-FAKEKEY/);
  assert.match(prime, /^Condition merge-sweep \[OVERDUE\] standing pickup, due now$/m);
  const section = cli(vault, events, 'handoff', '--stream', 'S', '--dry-run', '--no-worktree-sweep').out.split('## Commitments and conditions')[1]?.split('\n## ')[0] ?? '';
  assert.match(section, /standing `merge-sweep` \[overdue\]/);
  assert.doesNotMatch(section, /hunter2|sk-FAKEKEY/);
  assert.equal(isRoutine(DEFAULT_ROWS[2]), true, 'a built-in row exactly as shipped is still routine');
});

test('a decision shows its decide-by date, in fixed format only', () => {
  const decision = (id: string, by: string, extra: object = {}) => ({ id, kind: 'decision', pending: true, text: 'x', by, closedBy: null, state: undefined, ...extra });
  const out = commitmentLines([], [decision('k1x9', '2026-10-09'), decision('k2y8', '2026-10-09T14:00:00Z'), decision('k3z7', 'hunter2 Bruno-1987!'), decision('k4w6', 'x', { by: undefined, gate: 'date:2026-11-01' })]).join('\n');
  assert.match(out, /`k1x9` \[open\] kind: decision, due 2026-10-09$/m);
  assert.match(out, /`k2y8` \[open\] kind: decision, due 2026-10-09T14:00:00Z$/m);
  assert.match(out, /`k3z7` \[open\] kind: decision, due when decided$/m);
  assert.match(out, /`k4w6` \[open\] kind: decision, due 2026-11-01$/m);
  assert.doesNotMatch(out, /hunter2|Bruno/);
});

test('one bad standing row degrades alone: an absurd cadence is refused, and an already-stored one does not take prime or the handoff down', () => {
  const { vault, events } = setup();
  assert.equal(cli(vault, events, 'standing', 'add', 'yearly-thing', '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', '1e12').code, 1);
  assert.equal(validRow({ id: 'x', trigger: 't', action: 'a', who: 'w', everyHours: 1e12 }) !== null, true);
  const huge: StandingEvent = { op: 'add', id: 'yearly-thing', trigger: 't', action: 'a', who: 'w', everyHours: 1e12, at: new Date(NOON - 100 * HOUR).toISOString() };
  const states = standingState([huge, added('proxy-first', 'before prod'), ran('yearly-thing', 1)], healthy());
  const lines = conditionLines(states);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => /^Condition yearly-thing .*due unknown$/.test(l)));
  assert.ok(lines.some((l) => l.startsWith('Condition proxy-first ')));
  assert.equal(commitmentLines(states, []).filter((l) => l.startsWith('- standing')).length, 2);
});

test('cli: the standing add refusals do not echo the id, and a missing id gets a usage line', () => {
  const { vault, events } = setup();
  const bad = cli(vault, events, 'standing', 'add', 'Bruno-1987', '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', '1');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /the id must be lowercase words joined by hyphens/);
  assert.doesNotMatch(bad.err, /Bruno|1987/);
  const none = cli(vault, events, 'standing', 'add', '--trigger', 't', '--action', 'a', '--who', 'w', '--every-hours', '1');
  assert.equal(none.code, 1);
  assert.match(none.err, /standing add needs an id\. Usage:/);
});

test('loop-alive follows the heartbeat verdict: stalled or down fails even with the lock held, and a supervised loop with no lock passes', () => {
  const fresh = [ran('loop-alive', 0), ran('chain-next', 0), ran('tracker-reconcile', 0)];
  const verdict = (state: string) => healthy({ health: () => ({ state, line: `**Loop:** ${state} 12 min` }) });
  assert.equal(statusOf(fresh, verdict('stalled'), 'loop-alive'), 'failing');
  assert.equal(statusOf(fresh, verdict('down'), 'loop-alive'), 'failing');
  assert.equal(statusOf(fresh, verdict('ok'), 'loop-alive'), 'ok');
  assert.equal(statusOf(fresh, healthy({ loopPid: () => null, health: () => ({ state: 'quiet', line: '' }) }), 'loop-alive'), 'ok', 'quiet hours: the supervisor waits, no loop holds the lock');
  assert.equal(statusOf(fresh, healthy({ loopPid: () => null, health: () => ({ state: 'running', line: '' }) }), 'loop-alive'), 'failing');
  const detail = DEFAULT_ROWS.find((r) => r.id === 'loop-alive') && standingState(fresh, verdict('stalled')).find((s) => s.row.id === 'loop-alive')?.detail;
  assert.match(String(detail), /^Loop: stalled 12 min$/);
});
