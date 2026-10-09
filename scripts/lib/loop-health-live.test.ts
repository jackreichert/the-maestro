// Run: node --test scripts/lib/loop-health-live.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// local-config reads these at import, so set them before the dynamic imports.
const ledger = mkdtempSync(join(tmpdir(), 'lh-ledger-'));
process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.LEDGER_ROOT = ledger;
process.env.MAESTRO_EVENT_DIR = join(ledger, 'events');
process.env.MAESTRO_LOOP_SUPERVISOR = 'required'; // gives the health line a body with no loop running, so the digest suffix has something to attach to
const { CONTAINER_PROJECT } = await import('../local-config.ts');
const { digestDir, saveDigest, claimDigests } = await import('./digest-store.ts');
const { unreadDigestCount, liveLoopHealth } = await import('./loop-health-live.ts');

test('the unread count is the digest store\'s unseen files: none, then saved ones, then fewer once one is read', () => {
  assert.equal(unreadDigestCount(), 0, 'no store yet');
  const dir = digestDir(ledger, CONTAINER_PROJECT);
  saveDigest(dir, 'one', 1_000);
  saveDigest(dir, 'two', 2_000);
  saveDigest(dir, 'three', 3_000);
  assert.equal(unreadDigestCount(), 3);
  claimDigests(dir, 4_000).forEach((c) => c.finish());
  assert.equal(unreadDigestCount(), 0, 'finished claims are marked seen');
});

test('liveLoopHealth puts the unread digest count on its line, so a hard-coded 0 fails', () => {
  const dir = digestDir(ledger, CONTAINER_PROJECT);
  saveDigest(dir, 'four', 5_000);
  saveDigest(dir, 'five', 6_000);
  assert.equal(unreadDigestCount(), 2);
  const health = liveLoopHealth();
  assert.match(health.line, / · 2 unread digests$/);
  assert.equal(health.unreadDigests, 2);
});
