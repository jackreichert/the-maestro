import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from './event-inject.ts';
import { writeAdopt } from '../lib/adopt.ts';
import { addWatch } from '../lib/watch-registry.ts';

const HOOK = fileURLToPath(new URL('./event-inject.ts', import.meta.url));
const ok = { state: 'ok' as const, line: '**Loop:** ok 2 min' };
const base = { claim: () => [], health: () => ok };

test('the adoption block prints on SessionStart only, after the loop line', () => {
  const deps = { ...base, adoption: () => 'Adopted queue: /q (until x). Read it and work it now.' };
  assert.equal(inject('SessionStart', 'w', deps), `${ok.line}\nAdopted queue: /q (until x). Read it and work it now.`);
  assert.equal(inject('UserPromptSubmit', 'w', deps), '');
});

test('adoption alone is enough to print, even when the loop line is silent', () => {
  const quiet = { claim: () => [], health: () => ({ state: 'absent' as const, line: '' }), adoption: () => 'Adopted queue: /q' };
  assert.equal(inject('SessionStart', 'w', quiet), 'Adopted queue: /q');
});

test('a throwing adoption keeps the rest of the output', () => {
  assert.equal(inject('SessionStart', 'w', { ...base, adoption: () => { throw new Error('boom'); } }), ok.line);
});

test('the real hook prints the adopted queue and the wake schedule on SessionStart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-adopt-'));
  try {
    writeAdopt(dir, '/q/queue.md');
    addWatch(dir, { id: 'night', type: 'wake', target: 'hourly:7,37', report: 'work the queue' });
    const env = { ...process.env, MAESTRO_EVENT_DIR: dir, MAESTRO_WINDOW: '', CLAUDE_CODE_SESSION_ID: '', MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' };
    const start = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' }), encoding: 'utf8', env, timeout: 20_000 });
    assert.equal(start.status, 0);
    assert.match(start.stdout, /Adopted queue: \/q\/queue.md/);
    assert.match(start.stdout, /Wake night: hourly:7,37 - work the queue/);
    assert.match(start.stdout, /CronCreate cron="7,37 \* \* \* \*"/, 'no loop in a temp dir, so the mirror is printed');
    const prompt = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env, timeout: 20_000 });
    assert.ok(!prompt.stdout.includes('Adopted queue'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
