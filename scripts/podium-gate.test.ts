// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/podium-gate.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGate } from './lib/podium-gate/checks.ts';
import { httpProbe } from './lib/podium-gate/probe.ts';
import { startTempPodium } from './lib/podium-gate/temp-podium.ts';

const GATE = fileURLToPath(new URL('./podium-gate.ts', import.meta.url));
const gate = (args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('the temp Podium answers the gate over HTTP: five criteria, none thrown, none crashing on a missing piece', async () => {
  const podium = await startTempPodium(new Date('2026-10-06T15:00:00Z'));
  try {
    const results = await runGate(httpProbe(podium.url));
    assert.deepEqual(results.map((r) => r.id), ['tokens', 'home', 'shared-docs', 'handover', 'plain-language']);
    for (const r of results) assert.match(r.verdict, /^(pass|fail|not-built)$/);
    assert.ok(results.every((r) => !/the check itself failed/.test(r.detail)), JSON.stringify(results));
    assert.equal((await httpProbe(podium.url).get('/api/state')).status, 200);
  } finally { await podium.close(); }
});

test('the CLI prints a tally and exits 1 while any criterion is not met', () => {
  const r = gate([]);
  assert.match(r.out, /Podium v1 gate: \d+ pass, \d+ fail, \d+ not built yet, of 5/);
  assert.equal(r.code, r.out.includes('5 pass') ? 0 : 1);
});

test('--json prints one result per criterion', () => {
  const r = gate(['--json']);
  const parsed = JSON.parse(r.out) as { id: string }[];
  assert.equal(parsed.length, 5);
});

test('--url with nothing listening exits 2 with a message; a bad flag or a non-http url exits 2', () => {
  const dead = gate(['--url', 'http://127.0.0.1:1/']);
  assert.equal(dead.code, 2);
  assert.match(dead.err, /nothing answers/);
  assert.equal(gate(['--nope']).code, 2);
  assert.equal(gate(['--url', 'file:///etc/passwd']).code, 2);
});
