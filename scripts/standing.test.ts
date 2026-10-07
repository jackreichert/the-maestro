// Run: node --test scripts/standing.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROWS, STANDING_FILE, appendEvent, readEvents, standingBlock, standingState, validRow } from './lib/standing.ts';
import type { CheckContext, StandingEvent } from './lib/standing.ts';
import { addWatch } from './lib/watch-registry.ts';

const NOON = Date.parse('2026-10-06T12:00:00Z');
const HOUR = 3600_000;
const healthy = (over: Partial<CheckContext> = {}): CheckContext => ({
  now: NOON, loopPid: () => 4242, watches: () => ({ live: 3, expired: [] }), queue: () => ({ inflight: 1, queued: 2 }), pendingTransitions: () => [], ...over,
});
const ran = (id: string, hoursAgo: number): StandingEvent => ({ op: 'ran', id, evidence: 'did it', at: new Date(NOON - hoursAgo * HOUR).toISOString() });
const statusOf = (events: StandingEvent[], ctx: CheckContext, id: string) => standingState(events, ctx).find((s) => s.row.id === id)?.status;

test('the built-in rows cover the pickups the ticket names, each enforced by a check or a cadence', () => {
  assert.deepEqual(DEFAULT_ROWS.map((r) => r.id), ['loop-alive', 'chain-next', 'merge-sweep', 'branch-sweep', 'tracker-reconcile']);
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
  assert.match(prime[0], /Standing pickups \(3 need attention, 5 total\)/);
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
    env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', VAULT_ROOT: '', MAESTRO_EVENT_DIR: events, MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '', MAESTRO_PROJECTS_DIR: tmpdir() },
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
  assert.match(prime.out, /^Standing pickups \(\d need attention, 5 total\)/m);
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
