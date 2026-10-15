// Run: node --test scripts/lib/status-page/stream-order.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamOrder } from './render.ts';
import type { PageConfig } from './render.ts';

const cfg = (streams: string[], repoStreams: Record<string, string> = {}): PageConfig => ({ streams, repoStreams } as unknown as PageConfig);

test('streams named in today\'s priorities come first, in priority order; the rest keep their order', () => {
  const c = cfg(['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.deepEqual(streamOrder(c, [], ['Gamma', 'Beta']), ['Gamma', 'Beta', 'Alpha', 'Delta', 'other']);
});

test('no priorities leaves the order unchanged', () => {
  const c = cfg(['Alpha', 'Beta'], { svc: 'Gamma' });
  assert.deepEqual(streamOrder(c, ['Delta']), ['Alpha', 'Beta', 'Gamma', 'Delta', 'other']);
  assert.deepEqual(streamOrder(c, ['Delta'], []), ['Alpha', 'Beta', 'Gamma', 'Delta', 'other']);
});

test('priority matching ignores case, repeats and unset streams; other stays last', () => {
  const c = cfg(['Alpha', 'Beta']);
  assert.deepEqual(streamOrder(c, ['Gamma'], ['beta', undefined, 'BETA', 'other', 'Gamma']), ['Beta', 'Gamma', 'Alpha', 'other']);
});

test('a priority stream unknown to the config and the ledger is not invented', () => {
  assert.deepEqual(streamOrder(cfg(['Alpha']), [], ['Nope']), ['Alpha', 'other']);
});
