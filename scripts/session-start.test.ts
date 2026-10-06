// Run: node --test scripts/session-start.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ageText, sessionStart, STALE_MS } from './session-start.ts';
import type { StartDeps } from './session-start.ts';
import type { Watch } from './lib/types.ts';

const NOW = Date.parse('2026-10-06T15:00:00Z');
const HOUR = 3600_000;
const watch = (id: string, type: string, expires = NOW + HOUR): Watch => ({ op: 'add', id, type, target: '/s', done_when: '', report: '', created: '', expires: new Date(expires).toISOString(), notify: false, notify_overnight: false, interval: null });

/** Fake world: records adds and removes; `watches` is what the registry holds. */
function world(over: Partial<StartDeps> & { held?: Watch[] } = {}) {
  const added: string[] = [];
  const removed: string[] = [];
  const deps: StartDeps = {
    now: NOW, tz: 'UTC', loopCommand: 'node loop run',
    watches: () => over.held ?? [],
    removeWatch: (id) => { removed.push(id); },
    addWatch: (id, type) => { added.push(`${id}:${type}`); return { ok: true, message: 'added' }; },
    lockHolder: () => null,
    pageWrittenAt: () => NOW - 4 * 60_000,
    ...over,
  };
  return { deps, added, removed };
}

test('a fresh session registers both watches, reports the page age and prints the loop command', () => {
  const w = world();
  const r = sessionStart('/s', w.deps);
  assert.deepEqual(w.added, ['status-watch:status-watch', 'status-refresh:status-refresh']);
  assert.equal(r.failed, false);
  assert.match(r.lines[2], /Status page: updated 4 min ago \(2:56 PM UTC\)$/);
  assert.match(r.lines[3], /NOT RUNNING.*run_in_background: node loop run$/);
});

test('live watches are left alone, whatever their id, and a loop holding the lock is reported', () => {
  const w = world({ held: [watch('mine', 'status-watch'), watch('other', 'status-refresh')], lockHolder: () => 4242 });
  const r = sessionStart('/s', w.deps);
  assert.deepEqual(w.added, []);
  assert.deepEqual(w.removed, []);
  assert.match(r.lines[0], /already registered \(mine/);
  assert.match(r.lines[3], /running \(pid 4242\)/);
});

test('an expired watch the loop has not retired yet is removed and registered again', () => {
  const w = world({ held: [watch('status-watch', 'status-watch', NOW - 1), watch('status-refresh', 'status-refresh')] });
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
  assert.match(old.lines[2], /updated 16 min ago.*STALE/);
  const none = sessionStart('/s', world({ pageWrittenAt: () => null }).deps);
  assert.match(none.lines[2], /none yet.*journal\.ts podium/);
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
  const run = () => spawnSync(process.execPath, [new URL('./session-start.ts', import.meta.url).pathname, '--status-dir', status], { encoding: 'utf8', env: { ...process.env, MAESTRO_EVENT_DIR: events } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /status-watch: registered/);
  assert.match(first.stdout, /status-refresh: registered/);
  assert.match(first.stdout, /STALE/);
  assert.match(first.stdout, /NOT RUNNING/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /status-watch: already registered/);
  assert.match(second.stdout, /status-refresh: already registered/);
  writeFileSync(join(events, 'loop.lock'), String(process.pid));
  assert.match(run().stdout, new RegExp(`running \\(pid ${process.pid}\\)`));
});

test('a status directory that does not exist fails the registration with the type\'s own message', () => {
  const events = mkdtempSync(join(tmpdir(), 'session-start-events-'));
  const r = spawnSync(process.execPath, [new URL('./session-start.ts', import.meta.url).pathname, '--status-dir', join(events, 'nope')], { encoding: 'utf8', env: { ...process.env, MAESTRO_EVENT_DIR: events } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT registered.*must be the status directory/);
});
