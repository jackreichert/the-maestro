// Run: node --test scripts/status-refresh-slim.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sr-slim-'));
const out = join(root, 'out', 'Podium-Slim.md');
process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.LEDGER_ROOT = join(root, 'ledger');
process.env.MAESTRO_PODIUM_SLIM_OUT = out;
process.env.MAESTRO_MODE = 'slim';
const refresh = await import('./event-types/status-refresh.ts');
import type { RefreshIo } from './event-types/status-refresh.ts';

const io = (over: Partial<RefreshIo> = {}): RefreshIo => ({
  ledgerSig: () => 'a', prsDirtyAt: () => 0, userEditAt: () => null, pageAt: () => 0, prsFetchedAt: () => Date.now(), isQuiet: () => true,
  regenerate: () => undefined, snapshotAt: () => Date.now(), refreshSnapshot: () => undefined, ...over,
});

test('in slim mode a check rewrites the focused page through the real hook, with no GitHub read', () => {
  const status = join(root, 'status');
  refresh.check(status, { now: Date.now(), prev: null }, { ...io(), slimPage: refresh.realIo.slimPage });
  assert.ok(existsSync(out), 'the page exists after one check');
  assert.match(readFileSync(out, 'utf8'), /## Open questions/);
});

test('every check calls the page hook once and reports no error', () => {
  let calls = 0;
  const state = refresh.check('dir', { now: Date.now(), prev: null }, io({ slimPage: () => { calls += 1; } }));
  assert.equal(calls, 1);
  assert.equal(state.error, '');
});

test('without a hook (full mode) nothing is written', () => {
  const before = readFileSync(out, 'utf8');
  refresh.check('dir', { now: Date.now(), prev: null }, io());
  assert.equal(readFileSync(out, 'utf8'), before);
});
