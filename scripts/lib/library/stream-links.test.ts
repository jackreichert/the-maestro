// Run: node --test scripts/lib/library/stream-links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamLibraryLinks, streamProjects } from './stream-links.ts';

test('streamProjects: a listed project wins; otherwise the folder named like the stream and its mapped repos, only those with a note', () => {
  const has = (p: string): boolean => ['green-gables', 'avonlea-api'].includes(p);
  assert.deepEqual(streamProjects('Anything', ['listed-one'], {}, () => false), ['listed-one']);
  assert.deepEqual(streamProjects('Green Gables', [], { 'avonlea-api': 'Green Gables', 'orchard-web': 'Green Gables', 'x': 'Other' }, has), ['green-gables', 'avonlea-api']);
  assert.deepEqual(streamProjects('Orchard', [], {}, has), [], 'no folder, no project is claimed');
  assert.deepEqual(streamProjects('Green Gables', [], { 'green-gables': 'Green Gables' }, has), ['green-gables'], 'a repo named like the stream is listed once');
});

test('streamLibraryLinks links only an INDEX that exists, and nothing without a vault name', () => {
  const exists = (p: string): boolean => p === 'Projects/avonlea-api/INDEX.md';
  assert.deepEqual(streamLibraryLinks('Sample Vault', ['avonlea-api', 'orchard-web'], exists), [
    { project: 'avonlea-api', label: 'avonlea-api library', url: 'obsidian://open?vault=Sample%20Vault&file=Projects%2Favonlea-api%2FINDEX' },
  ]);
  assert.deepEqual(streamLibraryLinks('', ['avonlea-api'], exists), []);
});
