// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/gh-search.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS_BATCH, readPullRequests } from './gh-search.ts';
import type { Run } from './types.ts';

const ok = (data: unknown, errors?: unknown): ReturnType<Run> => ({ status: 0, stderr: '', stdout: JSON.stringify({ data, ...(errors ? { errors } : {}) }) });
const queryOf = (args: string[]): string => args.find((a) => a.startsWith('query=')) ?? '';

test('each key becomes one aliased repository/pullRequest read, and the PRs come back by key', () => {
  const seen: string[] = [];
  const run: Run = (_c, args) => { seen.push(queryOf(args)); return ok({ p0: { pullRequest: { number: 7 } }, p1: { pullRequest: { number: 9 } } }); };
  const r = readPullRequests<{ number: number }>(['acme/app#7', 'acme/web.site#9'], 'number', run);
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /p0: repository\(owner: "acme", name: "app"\) \{ pullRequest\(number: 7\) \{ number \} \}/);
  assert.match(seen[0] ?? '', /p1: repository\(owner: "acme", name: "web\.site"\) \{ pullRequest\(number: 9\)/);
  assert.deepEqual([...r.nodes].map(([k, n]) => [k, n.number]), [['acme/app#7', 7], ['acme/web.site#9', 9]]);
  assert.deepEqual([r.gone, r.failed], [[], []]);
});

test('keys go in small batches', () => {
  const calls: number[] = [];
  const keys = Array.from({ length: KEYS_BATCH * 2 + 3 }, (_, i) => `acme/app#${i + 1}`);
  const run: Run = (_c, args) => { calls.push((queryOf(args).match(/pullRequest\(/g) ?? []).length); return ok(Object.fromEntries(Array.from({ length: KEYS_BATCH }, (_, n) => [`p${n}`, { pullRequest: { number: n } }]))); };
  readPullRequests(keys, 'number', run);
  assert.deepEqual(calls, [KEYS_BATCH, KEYS_BATCH, 3]);
});

test('a key that is not shaped like a PR key never reaches the query text', () => {
  const run: Run = (_c, args) => { assert.ok(!queryOf(args).includes('evil'), 'unvalidated text in the query'); return ok({ p0: { pullRequest: { number: 1 } } }); };
  const r = readPullRequests(['acme/app#1', 'x") { id } evil: repository(owner: "a', '../x#1', 'acme/app#0'], 'number', run);
  assert.deepEqual([...r.nodes.keys()], ['acme/app#1']);
  assert.equal(r.failed.length, 3);
});

test('a PR GitHub reports as not found is gone; any other error fails the batch, never reads as gone', () => {
  const gone: Run = () => ok({ p0: null, p1: { pullRequest: { number: 2 } } }, [{ type: 'NOT_FOUND', path: ['p0'], message: 'Could not resolve to a Repository' }]);
  const a = readPullRequests(['acme/old#1', 'acme/app#2'], 'number', gone);
  assert.deepEqual([a.gone, [...a.nodes.keys()], a.failed], [['acme/old#1'], ['acme/app#2'], []]);
  const bad: Run = () => ok({ p0: null }, [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }]);
  const b = readPullRequests(['acme/app#1'], 'number', bad);
  assert.deepEqual([b.gone, b.failed], [[], ['acme/app#1']]);
  assert.match(b.error?.message ?? '', /rate limit/);
});

test('a failed batch keeps the batches already read', () => {
  let n = 0;
  const keys = Array.from({ length: KEYS_BATCH + 2 }, (_, i) => `acme/app#${i + 1}`);
  const run: Run = () => { n += 1; return n === 1 ? ok(Object.fromEntries(Array.from({ length: KEYS_BATCH }, (_, i) => [`p${i}`, { pullRequest: { number: i + 1 } }]))) : { status: 1, stderr: 'HTTP 502: Bad Gateway\nmore', stdout: '' }; };
  const r = readPullRequests(keys, 'number', run);
  assert.equal(r.nodes.size, KEYS_BATCH);
  assert.deepEqual(r.failed, [`acme/app#${KEYS_BATCH + 1}`, `acme/app#${KEYS_BATCH + 2}`]);
  assert.match(r.error?.message ?? '', /502/);
});

test('nothing to read makes no call', () => {
  const run: Run = () => { throw new Error('no call expected'); };
  assert.equal(readPullRequests([], 'number', run).nodes.size, 0);
});
