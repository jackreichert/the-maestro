// Run: node --test scripts/claim-same-window.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvents } from './lib/event-inbox.ts';
import { cleanEnv } from './lib/test-env.ts';

const CHILD = new URL('./claim-race-child.ts', import.meta.url).pathname;
const event = { watch: 'prs', type: 'pr-watch', at: '2026-10-01T12:00:00.000Z', summary: 'THREAD acme/web#7 by someone: u', actionable: true, report: '' };

/** Runs one caller as a child and resolves with how many events it took. */
const caller = (dir: string, window: string, me: string, rival: string) => new Promise<number>((resolve, reject) => {
  const p = spawn(process.execPath, [CHILD, dir, window, me, rival], { env: { ...cleanEnv(), MAESTRO_EVENT_DIR: dir } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`child exited ${code}`))));
});

test('two callers sharing a window id, overlapping between read and mark, deliver the event exactly once (50 races)', async () => {
  for (let i = 0; i < 50; i += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'claim-same-window-'));
    appendEvents(dir, [event]);
    const a = join(dir, 'ready-a');
    const b = join(dir, 'ready-b');
    const taken = await Promise.all([caller(dir, 'w1', a, b), caller(dir, 'w1', b, a)]);
    assert.equal(taken[0] + taken[1], 1, `race ${i}: taken ${taken.join(' and ')}`);
  }
});
