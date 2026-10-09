// Run: node --test scripts/status-refresh-snapshot.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installGhStub, prNode } from './lib/gh-stub.ts';

// local-config reads these at import, so set them before the dynamic imports.
const ledger = mkdtempSync(join(tmpdir(), 'sr-snap-ledger-'));
process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.LEDGER_ROOT = ledger;
const withStub = (config: Parameters<typeof installGhStub>[0]): void => { const env = installGhStub(config); process.env.PATH = env.PATH; process.env.GH_STUB_CONFIG = env.GH_STUB_CONFIG; };
const { realIo } = await import('./event-types/status-refresh.ts');
const { currentPath, snapshotPath } = await import('./prs-snapshot.ts');

test('the real refresh writes the current-state file from one search and makes the same file the next throttle reads', () => {
  const path = currentPath(ledger);
  assert.equal(realIo.snapshotAt(), 0, 'no snapshot yet');
  withStub({ pages: [[prNode(1), prNode(2, { isDraft: true })]] });
  assert.equal(realIo.refreshSnapshot(), undefined);
  assert.equal(existsSync(snapshotPath(ledger)), false, 'the --diff baseline file is never written by the refresh');
  const snap = JSON.parse(readFileSync(path, 'utf8')) as { takenAt: string; prs: { key: string }[] };
  assert.deepEqual(snap.prs.map((p) => p.key), ['org/repo#1', 'org/repo#2']);
  assert.ok(Math.abs(realIo.snapshotAt() - Date.now()) < 60_000, 'snapshotAt is the file\'s takenAt');
  assert.deepEqual(readdirSync(dirname(path)).filter((f) => f.includes('.tmp')), [], 'written by rename, no temp file left');
});

test('a failed gh search returns the reason, leaves the current-state file as it was and does not throw', () => {
  const path = currentPath(ledger);
  const before = readFileSync(path, 'utf8');
  withStub({ pages: [[prNode(9)]], failOnPage: 0 });
  const why = realIo.refreshSnapshot();
  assert.match(why ?? '', /gh api graphql failed: HTTP 502/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(existsSync(path));
});
