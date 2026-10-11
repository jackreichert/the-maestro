// Run: node --test scripts/lib/loop-health-live.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// local-config reads these at import, so set them before the dynamic imports.
const ledger = mkdtempSync(join(tmpdir(), 'lh-ledger-'));
process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.LEDGER_ROOT = ledger;
process.env.MAESTRO_EVENT_DIR = join(ledger, 'events');
process.env.MAESTRO_LOOP_SUPERVISOR = 'required'; // gives the health line a body with no loop running, so the digest suffix has something to attach to
const T0 = Date.now(); // digests older than 24 h are expired, so saved times must be recent
const { CONTAINER_PROJECT } = await import('../local-config.ts');
const { digestDir, saveDigest, claimDigests, unseenDigests } = await import('./digest-store.ts');
const { unreadDigestCount, liveLoopHealth } = await import('./loop-health-live.ts');

test('the unread count is the digest store\'s unseen files: none, then saved ones, then fewer once one is read', () => {
  assert.equal(unreadDigestCount(), 0, 'no store yet');
  const dir = digestDir(ledger, CONTAINER_PROJECT);
  saveDigest(dir, 'one', T0 + 1000);
  saveDigest(dir, 'two', T0 + 2000);
  saveDigest(dir, 'three', T0 + 3000);
  assert.equal(unreadDigestCount(), 3);
  claimDigests(dir, T0 + 4_000).forEach((c) => c.finish());
  assert.equal(unreadDigestCount(), 0, 'finished claims are marked seen');
});

test('liveLoopHealth puts the unread digest count on its line, so a hard-coded 0 fails', () => {
  const dir = digestDir(ledger, CONTAINER_PROJECT);
  saveDigest(dir, 'four', T0 + 5000);
  saveDigest(dir, 'five', T0 + 6000);
  assert.equal(unreadDigestCount(), 2);
  const health = liveLoopHealth();
  assert.match(health.line, / · 2 unread digests$/);
  assert.equal(health.unreadDigests, 2);
});

test('the footer read path counts digests older than 24h as unread and never writes the store', () => {
  const dir = join(ledger, 'old-store');
  const old = saveDigest(dir, 'ACTION weekend', Date.now() - 50 * 3600_000);
  const before = readFileSync(old, 'utf8');
  assert.equal(unseenDigests(dir).length, 1);
  assert.equal(unreadDigestCount(dir), 1);
  assert.equal(readFileSync(old, 'utf8'), before, 'status --footer must not mark anything seen');
});
