// Run: node --test scripts/lib/haiku-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredTriage, defaultRun, haikuTriage, parseAnswer } from './haiku-triage.ts';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rulesOnlyTriage } from './digest-triage.ts';
import type { ModelRun } from './haiku-triage.ts';

const INPUT = { watch: 'w', type: 'pr-watch', kind: 'thread', summary: 'THREAD org/repo#7 by dependabot[bot]: https://github.com/org/repo/pull/7#r1' };
const says = (stdout: string): ModelRun => () => ({ status: 0, stdout });

test('a clean JSON answer is passed through', () => {
  assert.deepEqual(haikuTriage({ run: says('{"verdict":"noise","reason":"bot thread on a dependency bump"}') })(INPUT), { verdict: 'noise', reason: 'bot thread on a dependency bump' });
  assert.equal(haikuTriage({ run: says('{"verdict":"actionable","reason":"asks a question"}') })(INPUT).verdict, 'actionable');
});

test('an answer wrapped in prose or a code fence is still read', () => {
  assert.equal(parseAnswer('```json\n{"verdict":"noise","reason":"bot"}\n```').verdict, 'noise');
  assert.equal(parseAnswer('Sure. {"verdict":"actionable","reason":"human asked"} Done.').verdict, 'actionable');
});

test('every failure is unsure, never noise', () => {
  const bad: [string, ModelRun][] = [
    ['non-zero exit', () => ({ status: 1, stdout: '{"verdict":"noise","reason":"x"}' })],
    ['timeout or spawn error', () => ({ status: null, stdout: '', error: new Error('ETIMEDOUT') })],
    ['signal kill', () => ({ status: null, stdout: '{"verdict":"noise","reason":"x"}', signal: 'SIGTERM' })],
    ['empty output', says('')],
    ['not json', says('this is noise')],
    ['unknown verdict', says('{"verdict":"ignore","reason":"x"}')],
    ['throwing runner', () => { throw new Error('boom'); }],
  ];
  for (const [name, run] of bad) assert.equal(haikuTriage({ run })(INPUT).verdict, 'unsure', name);
});

test('the model call is bounded, tool-less, uses the haiku model and gets the line on stdin only', () => {
  let seen: { cmd: string; args: string[]; input: string; timeoutMs: number } | undefined;
  haikuTriage({ timeoutMs: 1234, run: (cmd, args, o) => { seen = { cmd, args, input: o.input, timeoutMs: o.timeoutMs }; return { status: 0, stdout: '{"verdict":"unsure","reason":"r"}' }; } })(INPUT);
  assert.equal(seen?.cmd, 'claude');
  assert.equal(seen?.timeoutMs, 1234);
  const a = seen?.args ?? [];
  assert.equal(a[a.indexOf('--model') + 1], 'haiku');
  assert.ok(a.includes('-p'));
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(seen?.input.includes(INPUT.summary));
  assert.ok(!a.some((x) => x.includes(INPUT.summary)), 'line must not be in argv');
});

test('configuredTriage is the Haiku seam unless MAESTRO_TRIAGE=off, which keeps the rules-only seam', () => {
  assert.equal(configuredTriage({ MAESTRO_TRIAGE: 'off' }), rulesOnlyTriage);
  assert.notEqual(configuredTriage({}), rulesOnlyTriage);
  assert.equal(typeof configuredTriage({}), 'function');
});

test('a child that ignores SIGTERM is killed with SIGKILL at the timeout and the answer is unsure', () => {
  const bin = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const t0 = Date.now();
    const r = defaultRun('claude', ['-p'], { input: 'x', timeoutMs: 1000 });
    assert.equal(r.signal, 'SIGKILL', 'SIGTERM can be ignored, so the timeout must kill outright');
    assert.ok(Date.now() - t0 < 6000);
    assert.equal(haikuTriage({ timeoutMs: 1000 })(INPUT).verdict, 'unsure');
  } finally { process.env.PATH = path; }
});
