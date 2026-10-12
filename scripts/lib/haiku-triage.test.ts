// Run: node --test scripts/lib/haiku-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haikuTriage, parseAnswer } from './haiku-triage.ts';
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
