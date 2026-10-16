// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/scripts/registry.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_COMMAND, MAX_PROSE, appendEntry, blockPath, keyOf, readScripts, recordRan, scriptsPath, validateScript, writeBlock } from './registry.ts';
import type { NewScript } from './registry.ts';

const OK: NewScript = { kind: 'one-time', title: 'Close ticket 12', what: 'Closes one vault ticket.', why: 'The agent cannot write the vault.', after: 'The ticket is closed.', blocks: 'abcd', blockedBy: 'repo-worker: close ticket', command: 'node ticket.mjs close --project the-maestro 12' };
const NOW = new Date('2026-10-15T15:00:00Z');
const vault = (): string => mkdtempSync(join(tmpdir(), 'scripts-registry-'));

test('a complete entry passes, and the command may span lines', () => {
  assert.deepEqual(validateScript(OK), []);
  assert.deepEqual(validateScript({ ...OK, command: 'cd /tmp/x\n/opt/homebrew/bin/node a.ts' }), []);
});

test('every missing or malformed field is named, not just the first', () => {
  const errors = validateScript({ ...OK, kind: 'sometimes' as never, title: '', what: 'two\nlines', why: 'x'.repeat(MAX_PROSE + 1), after: '', blocks: 'no spaces allowed', command: '  ' });
  assert.equal(errors.length, 7, errors.join(' | '));
  assert.match(errors.join('\n'), /--kind[\s\S]*--title[\s\S]*--what[\s\S]*--why[\s\S]*--after[\s\S]*--blocks[\s\S]*command is empty/);
});

test('a command over the cap, or with control characters, is refused', () => {
  assert.match(validateScript({ ...OK, command: 'echo '.padEnd(MAX_COMMAND + 1, 'a') }).join(), /over 8000/);
  assert.match(validateScript({ ...OK, command: 'echo hi\u0007' }).join(), /control or direction-changing/);
});

test('a secret-shaped value is refused wherever it sits, and no env value is ever stored', () => {
  const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  assert.match(validateScript({ ...OK, command: `aws s3 ls --access-key ${key}` }).join(), /secret/);
  assert.match(validateScript({ ...OK, why: `needed because ${key}` }).join(), /--why looks like a secret/);
  assert.match(validateScript({ ...OK, blockedBy: `agent ${key}` }).join(), /--blocked-by looks like a secret/);
  assert.match(validateScript({ ...OK, command: 'printenv' }).join(), /env-dump|environment/);
  assert.match(validateScript({ ...OK, command: 'cat .env.local' }).join(), /secret file/);
});

test('the command is held to the run-this guard, so a script that could never run is refused up front', () => {
  assert.match(validateScript({ ...OK, command: 'node scripts/journal.ts status' }).join(), /run-this guard[\s\S]*bare-node-ts/);
});

test('storage: the block file is the command verbatim (0600), the add row round-trips, and reads skip junk and an unknown ran id', () => {
  const v = vault();
  const block = writeBlock({ vault: v, project: 'p', id: 'sc-00000001', command: OK.command });
  assert.equal(block, blockPath(v, 'p', 'sc-00000001'));
  assert.equal(readFileSync(block, 'utf8'), `${OK.command}\n`);
  assert.equal(statSync(block).mode & 0o777, 0o600);
  const entry = appendEntry({ vault: v, project: 'p', id: 'sc-00000001', script: OK, ask: 'ab12', now: NOW });
  appendEntry({ vault: v, project: 'p', id: 'sc-00000001', script: { ...OK, title: 'second add of the same id' }, ask: 'ab13', now: NOW });
  recordRan({ vault: v, project: 'p', id: 'sc-00000001', result: 'done', via: 'podium', now: NOW });
  recordRan({ vault: v, project: 'p', id: 'sc-ffffffff', result: 'done', via: 'podium', now: NOW });
  const file = scriptsPath(v, 'p');
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n{"ev":"add","id":"sc-00000002"}\n{"ev":"ran","id":"sc-00000001","at":"x","result":"maybe","via":"cli"}\n`);
  const got = readScripts(file);
  assert.deepEqual(got.entries, [entry], 'the first add of an id wins; a half-formed row is dropped');
  assert.equal(got.ran.length, 1, 'only a well-formed ran row for a known id counts');
  assert.deepEqual(readScripts(join(v, 'missing.jsonl')), { entries: [], ran: [] });
});

test('the registration key ignores the prose but not the command', () => {
  assert.equal(keyOf(OK), keyOf({ ...OK, what: 'reworded' } as NewScript));
  assert.notEqual(keyOf(OK), keyOf({ ...OK, command: `${OK.command} 13` }));
});

test('direction-changing and invisible characters are refused in the prose and the command', () => {
  assert.match(validateScript({ ...OK, title: 'a‮b' }).join(), /--title/);
  assert.match(validateScript({ ...OK, command: 'echo ‮hi' }).join(), /direction-changing/);
});
