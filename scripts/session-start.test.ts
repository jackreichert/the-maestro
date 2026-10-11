// Run: node --test scripts/session-start.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { ageText, connects, repairStandingWatches, sessionStart, STALE_MS } from './session-start.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import { listWatches } from './lib/watch-registry.ts';
import type { StartDeps } from './session-start.ts';
import type { Watch } from './lib/types.ts';
import { cleanEnv } from './lib/test-env.ts';
import { startLockOwner } from './lib/lock-owner-fixture.ts';

const NOW = Date.parse('2026-10-06T15:00:00Z');
const HOUR = 3600_000;
const watch = (id: string, type: string, expires = NOW + HOUR, target = '/s'): Watch => ({ op: 'add', id, type, target, done_when: '', report: '', created: '', expires: new Date(expires).toISOString(), notify: false, notify_overnight: false, interval: null });

/** The report line that starts with `prefix`; the per-watch lines come first, so later lines are found by what they say. */
const lineOf = (r: { lines: string[] }, prefix: string): string => r.lines.find((l) => l.startsWith(prefix)) ?? '';

/** Fake world: records adds and removes; `watches` is what the registry holds. */
function world(over: Partial<StartDeps> & { held?: Watch[] } = {}) {
  const added: string[] = [];
  const removed: string[] = [];
  const deps: StartDeps = {
    now: NOW, tz: 'UTC', loopCommand: 'node loop run',
    watches: () => over.held ?? [],
    removeWatch: (id) => { removed.push(id); },
    addWatch: (id, type) => { added.push(`${id}:${type}`); return { ok: true, message: 'added' }; },
    lockHolder: () => null, waitCommand: 'node loop digest-wait',
    pageWrittenAt: () => NOW - 4 * 60_000,
    ...over,
  };
  return { deps, added, removed };
}

test('a fresh session registers every needed watch, reports the page age and prints the loop command', () => {
  const w = world();
  const r = sessionStart('/s', w.deps);
  assert.deepEqual(w.added, ['status-watch:status-watch', 'status-refresh:status-refresh', 'retro-due:retro-due', 'whats-next:whats-next']);
  assert.equal(r.failed, false);
  assert.match(lineOf(r, 'Status page'), /Status page: updated 4 min ago \(2:56 PM UTC\)$/);
  assert.match(lineOf(r, 'Event loop'), /NOT RUNNING.*run_in_background: node loop run$/);
});

test('live watches are left alone, whatever their id, and a loop holding the lock is reported', () => {
  const w = world({ held: [watch('mine', 'status-watch'), watch('other', 'status-refresh'), watch('next', 'whats-next'), watch('third', 'retro-due')], lockHolder: () => 4242 });
  const r = sessionStart('/s', w.deps);
  assert.deepEqual(w.added, []);
  assert.deepEqual(w.removed, []);
  assert.match(r.lines[0], /already registered \(mine/);
  assert.match(lineOf(r, 'Event loop'), /running \(pid 4242\).*supervisor.*node loop digest-wait$/);
});

test('an expired watch the loop has not retired yet is removed and registered again', () => {
  const w = world({ held: [watch('status-watch', 'status-watch', NOW - 1), watch('status-refresh', 'status-refresh'), watch('whats-next', 'whats-next'), watch('retro-due', 'retro-due')] });
  sessionStart('/s', w.deps);
  assert.deepEqual(w.removed, ['status-watch']);
  assert.deepEqual(w.added, ['status-watch:status-watch']);
});

test('a refused registration is reported and fails the run, and the other watch is still tried', () => {
  const w = world({ addWatch: (id) => (id === 'status-watch' ? { ok: false, message: 'target must be a directory' } : { ok: true, message: 'added' }) });
  const r = sessionStart('/s', w.deps);
  assert.equal(r.failed, true);
  assert.match(r.lines[0], /status-watch: NOT registered \(target must be a directory\)/);
  assert.match(r.lines[1], /status-refresh: registered/);
});

test('a page older than 15 minutes is flagged stale; a missing page says how to make one', () => {
  const old = sessionStart('/s', world({ pageWrittenAt: () => NOW - STALE_MS - 60_000 }).deps);
  assert.match(lineOf(old, 'Status page'), /updated 16 min ago.*STALE/);
  const none = sessionStart('/s', world({ pageWrittenAt: () => null }).deps);
  assert.match(lineOf(none, 'Status page'), /none yet.*journal\.ts podium/);
});

test('a concurrent start that registered the watch first counts as success', () => {
  let reads = 0;
  const w = world({ watches: () => (reads++ < 1 ? [] : [watch('status-watch', 'status-watch'), watch('status-refresh', 'status-refresh'), watch('whats-next', 'whats-next'), watch('retro-due', 'retro-due')]), addWatch: () => ({ ok: false, message: 'already runs' }) });
  const r = sessionStart('/s', w.deps);
  assert.equal(r.failed, false);
  assert.match(r.lines[0], /already registered/);
});

test('an existing watch aimed at another directory is called out', () => {
  const r = sessionStart('/s', world({ held: [watch('status-watch', 'status-watch', NOW + HOUR, '/elsewhere'), watch('status-refresh', 'status-refresh'), watch('retro-due', 'retro-due')] }).deps);
  assert.match(r.lines[0], /WARNING its target is \/elsewhere, not \/s/);
  assert.doesNotMatch(r.lines[1], /WARNING/);
});

test('ageText reads in minutes, hours and days', () => {
  assert.equal(ageText(-5), '0 min');
  assert.equal(ageText(60_000), '1 min');
  assert.equal(ageText(125 * 60_000), '2 h 5 min');
  assert.equal(ageText(72 * HOUR), '3 days');
});

test('end to end: registers through event-loop.ts add, then a second run changes nothing', () => {
  const events = mkdtempSync(join(tmpdir(), 'session-start-events-'));
  const status = mkdtempSync(join(tmpdir(), 'session-start-status-'));
  const page = join(status, 'The-Podium.md');
  writeFileSync(page, '# page\n');
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(page, old, old);
  const run = () => spawnSync(process.execPath, [new URL('./session-start.ts', import.meta.url).pathname, '--status-dir', status], { encoding: 'utf8', env: { ...cleanEnv(), MAESTRO_EVENT_DIR: events } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /status-watch: registered/);
  assert.match(first.stdout, /status-refresh: registered/);
  assert.match(first.stdout, /whats-next: registered/);
  assert.match(first.stdout, /retro-due: registered/);
  assert.match(first.stdout, /STALE/);
  assert.match(first.stdout, /NOT RUNNING/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /status-watch: already registered/);
  assert.match(second.stdout, /status-refresh: already registered/);
  assert.match(second.stdout, /whats-next: already registered/);
  assert.match(second.stdout, /retro-due: already registered/);
  const owner = startLockOwner();
  try {
    writeFileSync(join(events, 'loop.lock'), String(owner.pid));
    assert.match(run().stdout, new RegExp(`running \\(pid ${owner.pid}\\)`));
  } finally { owner.stop(); }
});

test('a status directory that does not exist fails the registration with the type\'s own message', () => {
  const events = mkdtempSync(join(tmpdir(), 'session-start-events-'));
  const r = spawnSync(process.execPath, [new URL('./session-start.ts', import.meta.url).pathname, '--status-dir', join(events, 'nope')], { encoding: 'utf8', env: { ...cleanEnv(), MAESTRO_EVENT_DIR: events } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT registered.*must be the status directory/);
});

test('the loop health verdict prints just before the event loop line, without footer markup, and nothing when it is empty', () => {
  const said = sessionStart('/s', world({ loopHealth: () => '**Loop:** STALLED 20 min (no heartbeat since 1:40 PM EDT)' }).deps).lines;
  const at = said.indexOf('Loop: STALLED 20 min (no heartbeat since 1:40 PM EDT)');
  assert.ok(at > 0, 'the verdict is printed');
  assert.match(said[at + 1]!, /^Event loop:/);
  const quiet = sessionStart('/s', world({ loopHealth: () => '' }).deps).lines;
  assert.equal(quiet.length, said.length - 1, 'an empty verdict adds no line');
});

test('session start says which watches it marked standing, and nothing when none needed it', () => {
  assert.equal(sessionStart('/s', world({ repairStanding: () => [] }).deps).lines.some((l) => /Standing watches/.test(l)), false);
  const line = sessionStart('/s', world({ repairStanding: () => ['prs', 'texts'] }).deps).lines.find((l) => /Standing watches/.test(l));
  assert.match(String(line), /^Standing watches: marked prs, texts as renewing/);
});

test('repairStandingWatches marks a standing-type watch that lacks the flag, once, keeping its expiry; other types are left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-'));
  const old = JSON.stringify({ op: 'add', id: 'prs', type: 'pr-watch', target: 'org', done_when: '', report: '', created: '2026-10-02T00:00:00Z', expires: '2026-10-09T00:00:00.000Z', notify: false, notify_overnight: false, interval: null });
  const plain = JSON.stringify({ op: 'add', id: 'once', type: 'reminder', target: 'x', done_when: '', report: '', created: '2026-10-02T00:00:00Z', expires: '2026-10-09T00:00:00.000Z', notify: true, notify_overnight: false, interval: null });
  writeFileSync(join(dir, 'watches.jsonl'), `${old}\n${plain}\n`);
  assert.deepEqual(repairStandingWatches(dir, BUILTIN_TYPES, NOW), ['prs']);
  const after = listWatches(dir);
  assert.equal(after.find((w) => w.id === 'prs')?.renew, true);
  assert.equal(after.find((w) => w.id === 'prs')?.expires, '2026-10-09T00:00:00.000Z');
  assert.equal(after.find((w) => w.id === 'once')?.renew, undefined);
  assert.deepEqual(repairStandingWatches(dir, BUILTIN_TYPES, NOW), [], 'idempotent');
});

test('a Podium web link that does not answer prints the down line; an answering one, and no link, print nothing', () => {
  const down = sessionStart('/s', world({ webProbe: () => ({ url: 'http://127.0.0.1:47700/', up: false }) }).deps).lines;
  assert.match(down.find((l) => l.startsWith('Podium web:')) ?? '', /^Podium web: down \(nothing answers at http:\/\/127\.0\.0\.1:47700\/\)/);
  for (const probe of [() => ({ url: 'http://127.0.0.1:47700/', up: true }), () => ({ url: '', up: true })]) {
    assert.equal(sessionStart('/s', world({ webProbe: probe }).deps).lines.some((l) => l.startsWith('Podium web:')), false);
  }
});

test('connects is true for a listening port, false for a closed one and a bad URL, and never waits long', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const { port } = server.address() as AddressInfo;
  assert.equal(connects(`http://127.0.0.1:${port}/`), true);
  await new Promise((ok) => server.close(ok));
  const t = Date.now();
  assert.equal(connects(`http://127.0.0.1:${port}/`), false);
  assert.equal(connects('not a url'), false);
  assert.ok(Date.now() - t < 3000);
});

test('unread digests are drained into the report once, ahead of the loop line', () => {
  const w = world({ drainDigests: () => ['ACTION pr merged', 'ACTION loop down'] });
  const r = sessionStart('/s', w.deps);
  const i = r.lines.findIndex((l) => l.startsWith('Unread digests (2)'));
  assert.ok(i >= 0);
  assert.deepEqual(r.lines.slice(i + 1, i + 3), ['ACTION pr merged', 'ACTION loop down']);
  assert.equal(sessionStart('/s', world().deps).lines.some((l) => l.startsWith('Unread digests')), false);
});
