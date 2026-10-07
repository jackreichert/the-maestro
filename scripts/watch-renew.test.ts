// Run: node --test scripts/watch-renew.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import type { TypeRegistry } from './event-types/index.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import type { EventType } from './lib/types.ts';
import { DEFAULT_TTL_MS, addWatch, listWatches, paths, removeWatch, renewWatch } from './lib/watch-registry.ts';

const SCRIPT = new URL('./event-loop.ts', import.meta.url).pathname;
const HOUR = 3600 * 1000;
const NOON = Date.parse('2026-10-01T12:00:00Z');
const tempDir = () => mkdtempSync(join(tmpdir(), 'watch-renew-test-'));
const quiet = (extra: Partial<EventType> = {}): EventType => ({ check: () => ({}), diff: () => [], ...extra });
const expiresOf = (dir: string, id: string): number => Date.parse(listWatches(dir).find((w) => w.id === id)?.expires ?? '');
const run = (dir: string, types: TypeRegistry, now: number) => tick({ dir, types, config: { quietHours: 'off', tz: 'UTC' }, now });

test('a standing watch under half its TTL is renewed to a full TTL, not retired', () => {
  const dir = tempDir();
  const types: TypeRegistry = { standing: quiet({ renews: true, defaultTtlMs: () => 72 * HOUR }) };
  addWatch(dir, { id: 's', type: 'standing', target: 'x', ttlMs: 72 * HOUR, renew: true }, NOON);
  const later = NOON + 40 * HOUR;
  const r = run(dir, types, later);
  assert.deepEqual(r.retired, []);
  assert.equal(expiresOf(dir, 's'), later + 72 * HOUR);
});

test('a standing watch with more than half its TTL left is left alone (no log growth every tick)', () => {
  const dir = tempDir();
  const types: TypeRegistry = { standing: quiet({ renews: true, defaultTtlMs: () => 72 * HOUR }) };
  addWatch(dir, { id: 's', type: 'standing', target: 'x', ttlMs: 72 * HOUR, renew: true }, NOON);
  run(dir, types, NOON + 10 * HOUR);
  run(dir, types, NOON + 11 * HOUR);
  assert.equal(expiresOf(dir, 's'), NOON + 72 * HOUR);
});

test('a standing watch already past expiry (loop was down) is renewed, not retired with an expiry event', () => {
  const dir = tempDir();
  const types: TypeRegistry = { standing: quiet({ renews: true }) };
  addWatch(dir, { id: 's', type: 'standing', target: 'x', renew: true }, NOON);
  const later = NOON + 3 * 24 * HOUR;
  const r = run(dir, types, later);
  assert.deepEqual(r.retired, []);
  assert.deepEqual(r.events, []);
  assert.equal(expiresOf(dir, 's'), later + DEFAULT_TTL_MS);
});

test('a watch not marked renew expires even when its type renews (an explicit short ttl is honoured)', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'short', type: 'standing', target: 'x', ttlMs: HOUR }, NOON);
  const r = run(dir, { standing: quiet({ renews: true }) }, NOON + 2 * HOUR);
  assert.deepEqual(r.retired.map((x) => x.reason), ['expired']);
});

test('a type that does not renew still expires and says so', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'o', type: 'plain', target: 'x' }, NOON);
  const r = run(dir, { plain: quiet() }, NOON + 25 * HOUR);
  assert.deepEqual(r.retired.map((x) => x.reason), ['expired']);
  assert.equal(listWatches(dir).length, 0);
});

test('a nonsense defaultTtlMs falls back to the 24 h default rather than writing a bad expiry', () => {
  const dir = tempDir();
  for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    const id = `s${String(bad).replace(/\W/g, '')}`;
    addWatch(dir, { id, type: 'standing', target: 'x', renew: true }, NOON);
    run(dir, { standing: quiet({ renews: true, defaultTtlMs: () => bad }) }, NOON + 20 * HOUR);
    assert.equal(expiresOf(dir, id), NOON + 20 * HOUR + DEFAULT_TTL_MS, String(bad));
  }
});

test('renewWatch refuses an unknown id and a non-finite time, and a removed watch stays removed', () => {
  const dir = tempDir();
  assert.equal(renewWatch(dir, 'nope', NOON + HOUR), false);
  addWatch(dir, { id: 'a', type: 't', target: 'x' }, NOON);
  assert.equal(renewWatch(dir, 'a', Number.NaN), false);
  assert.equal(renewWatch(dir, 'a', NOON + 5 * HOUR), true);
  removeWatch(dir, 'a', 'gone', NOON);
  assert.deepEqual(listWatches(dir), []);
  addWatch(dir, { id: 'a', type: 't', target: 'y', ttlMs: HOUR }, NOON);
  assert.equal(expiresOf(dir, 'a'), NOON + HOUR, 'a renew from before the tombstone must not carry over');
});

test('a corrupt renew line is skipped; the watch keeps its previous expiry', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'a', type: 't', target: 'x' }, NOON);
  appendFileSync(paths(dir).watches, `${JSON.stringify({ op: 'renew', id: 'a', expires: 'garbage' })}\n{not json\n`);
  assert.equal(expiresOf(dir, 'a'), NOON + DEFAULT_TTL_MS);
});

test('cli add marks a standing type renew unless --ttl-hours is given, and a one-shot type never', () => {
  const dir = tempDir();
  const add = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, 'add', ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir } });
  assert.equal(add('--id', 'inb', '--type', 'inbox', '--target', 'true').status, 0);
  assert.equal(add('--id', 'inb2', '--type', 'inbox', '--target', 'true', '--ttl-hours', '2').status, 0);
  assert.equal(add('--id', 'rem', '--type', 'reminder', '--target', '2099-01-01T09:00:00Z').status, 0);
  const byId = Object.fromEntries(listWatches(dir).map((w) => [w.id, w.renew]));
  assert.deepEqual(byId, { inb: true, inb2: undefined, rem: undefined });
});

test('the standing built-in types opt in; one-shot types do not', () => {
  for (const name of ['pr-watch', 'inbox', 'status-watch', 'status-refresh', 'notion-watch']) assert.equal(BUILTIN_TYPES[name].renews, true, name);
  for (const name of ['pr-checks', 'pr-merged', 'gh-run', 'reminder']) assert.notEqual(BUILTIN_TYPES[name].renews, true, name);
});
