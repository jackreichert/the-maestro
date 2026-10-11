// Run: node --test scripts/lib/digest-migrate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDigests, parseDigest } from './digest-migrate.ts';
import { saveDigest, savedAt, unseenDigests } from './digest-store.ts';
import { readInbox } from './event-inbox.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'digest-migrate-test-'));
const AT = Date.parse('2026-10-06T14:35:00.123Z');

test('digest lines parse into events: actionable flag, watch, type, summary and report hint', () => {
  assert.deepEqual(parseDigest('ACTION prs (pr-watch): THREAD acme/widget#4 by a human | report: tell me\ninfo w2 (reminder): fired\nnot a digest line', '2026-10-06T14:35:00.123Z'), [
    { watch: 'prs', type: 'pr-watch', at: '2026-10-06T14:35:00.123Z', summary: 'THREAD acme/widget#4 by a human', actionable: true, report: 'tell me' },
    { watch: 'w2', type: 'reminder', at: '2026-10-06T14:35:00.123Z', summary: 'fired', actionable: false, report: '' },
  ]);
});

test('the save time comes from the digest file name', () => {
  const file = saveDigest(tempDir(), 'x', AT);
  assert.equal(savedAt(file), '2026-10-06T14:35:00.123Z');
  assert.equal(savedAt('/x/odd.md'), null);
});

test('unseen digests move into the inbox once: the digests are marked seen, and a second pass adds nothing', () => {
  const digests = tempDir();
  const events = tempDir();
  saveDigest(digests, 'ACTION prs (pr-watch): CONFLICT acme/widget#4 main <- feature\ninfo w2 (reminder): fired', AT);
  const first = migrateDigests(events, digests);
  assert.deepEqual(first, { digests: 1, added: 2, duplicates: 0, refused: 0 });
  assert.equal(readInbox(events).length, 2);
  assert.deepEqual(unseenDigests(digests), []);
  assert.deepEqual(migrateDigests(events, digests), { digests: 0, added: 0, duplicates: 0, refused: 0 });
});

test('a digest replayed after a crash between the append and the mark adds no second event', () => {
  const digests = tempDir();
  const events = tempDir();
  const file = saveDigest(digests, 'ACTION prs (pr-watch): CONFLICT acme/widget#4 main <- feature', AT);
  migrateDigests(events, digests);
  // Put the digest back as unseen, as a crash before the mark would have left it.
  saveDigest(digests, 'ACTION prs (pr-watch): CONFLICT acme/widget#4 main <- feature', AT);
  assert.equal(unseenDigests(digests).length, 1);
  assert.ok(file);
  assert.deepEqual(migrateDigests(events, digests), { digests: 1, added: 0, duplicates: 1, refused: 0 });
  assert.equal(readInbox(events).length, 1);
});

test('a missing digest directory is nothing to migrate', () => {
  assert.deepEqual(migrateDigests(tempDir(), join(tempDir(), 'none')), { digests: 0, added: 0, duplicates: 0, refused: 0 });
});
