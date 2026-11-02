import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, overHardLine, run } from './agent-guard.ts';
import type { GuardCtx } from './agent-guard.ts';
import { parseBudget } from '../lib/budget.ts';

const slim: GuardCtx = { mode: 'slim', overHard: false };
const call = (tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ tool_input, ...extra });

test('full mode allows everything, even a call with no model', () => {
  assert.equal(decide(call({ description: 'x' }), { mode: 'full', overHard: true }).deny, false);
});

test('slim: a missing or blank model is denied and the reason says to pass model explicitly', () => {
  for (const ti of [{ description: 'x' }, { description: 'x', model: '' }, { description: 'x', model: 'gpt-4' }]) {
    const d = decide(call(ti), slim);
    assert.equal(d.deny, true);
    assert.match(d.reason ?? '', /pass model explicitly/i);
  }
});

test('slim: haiku, sonnet and full model ids are allowed', () => {
  for (const model of ['haiku', 'sonnet', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001']) assert.equal(decide(call({ model, description: 'fix' }), slim).deny, false, model);
});

test('slim: opus is allowed for planning only', () => {
  assert.equal(decide(call({ model: 'opus', subagent_type: 'Plan', description: 'x' }), slim).deny, false);
  assert.equal(decide(call({ model: 'opus', description: 'Plan the rollout' }), slim).deny, false);
  assert.equal(decide(call({ model: 'opus', description: 'x', prompt: 'Please PLAN this.' }), slim).deny, false);
  assert.equal(decide(call({ model: 'claude-opus-4-1', description: 'x', prompt: 'make a plan' }), slim).deny, false);
  for (const ti of [{ description: 'implement it' }, { description: 'planner tweaks', prompt: 'explain' }, { description: 'airplane' }]) {
    const d = decide(call({ model: 'opus', ...ti }), slim);
    assert.equal(d.deny, true, JSON.stringify(ti));
    assert.match(d.reason ?? '', /opus/i);
  }
});

test('slim past the hard line: sonnet and opus (even a plan) are denied, haiku passes', () => {
  const over: GuardCtx = { mode: 'slim', overHard: true };
  assert.equal(decide(call({ model: 'sonnet', description: 'x' }), over).deny, true);
  assert.equal(decide(call({ model: 'opus', subagent_type: 'Plan' }), over).deny, true);
  assert.equal(decide(call({ model: 'haiku', description: 'x' }), over).deny, false);
});

test('a call made by a subagent is not checked', () => {
  assert.equal(decide(call({ description: 'x' }, { agent_id: 'a1' }), { mode: 'slim', overHard: true }).deny, false);
});

test('run prints the PreToolUse deny JSON, and nothing on allow', () => {
  const out = run(JSON.stringify(call({ description: 'x' })), slim) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason);
  assert.equal(run(JSON.stringify(call({ model: 'haiku' })), slim), null);
  assert.equal(run('not json', slim), null);
});

const cfg = parseBudget({ monthly: '500', startDay: '5', days: 'all', warn: '0.8', hard: '1', weekendWeight: '1' });
const NOW = Date.parse('2026-11-10T15:00:00Z');
const cacheWith = (body: string | null): string => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  if (body !== null) writeFileSync(join(dir, 'spend-cache.json'), body);
  return dir;
};
const cacheJson = (today: number) => JSON.stringify({ at: NOW, since: '2026-11-05', daily: { '2026-11-10': today } });

test('overHardLine reads the cached spend: over, under, missing and garbled', () => {
  assert.equal(overHardLine(cfg, cacheWith(cacheJson(1000)), 'UTC', NOW), true);
  assert.equal(overHardLine(cfg, cacheWith(cacheJson(0.5)), 'UTC', NOW), false);
  assert.equal(overHardLine(cfg, cacheWith(null), 'UTC', NOW), false);
  assert.equal(overHardLine(cfg, cacheWith('{garbled'), 'UTC', NOW), false);
  assert.equal(overHardLine(parseBudget({ monthly: '0', startDay: '1', days: 'all', warn: '0.8', hard: '1' }), cacheWith(cacheJson(1000)), 'UTC', NOW), false);
});

test('overHardLine on a weight-0 day: any recorded spend is over, none is not', () => {
  const weekdaysOnly = parseBudget({ monthly: '500', startDay: '5', days: 'weekdays', warn: '0.8', hard: '1', weekendWeight: '0' });
  const SAT = Date.parse('2026-11-07T15:00:00Z');
  const satCache = (today: number) => cacheWith(JSON.stringify({ at: SAT, since: '2026-11-05', daily: { '2026-11-07': today } }));
  assert.equal(overHardLine(weekdaysOnly, satCache(5), 'UTC', SAT), true);
  assert.equal(overHardLine(weekdaysOnly, satCache(0), 'UTC', SAT), false);
});
