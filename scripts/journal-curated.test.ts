// Run: node --test scripts/journal-curated.test.ts
// Hermetic: a temp vault. A curated row is written only by library-write, never by `log --kind curated`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;

test('log --kind curated is refused and writes nothing', () => {
  const vault = mkdtempSync(join(tmpdir(), 'journal-curated-'));
  const r = spawnSync(process.execPath, [SCRIPT, 'log', 'sneaky close', '--kind', 'curated', '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8',
    env: { ...process.env, VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_STATUS_DIR: join(vault, 'status'), MAESTRO_EVENT_DIR: join(vault, 'Events') },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /written only by `library-write\.ts curate`/);
  assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl')), false);
});
