// Run: node --test scripts/journal-drift.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftLine, missingAgentHooks, runningAgents, untrackedAgents } from './lib/journal/agent-drift.ts';
import * as cont from './event-types/continuity.ts';
import type { ContinuityState } from './event-types/continuity.ts';
import type { LedgerItem } from './lib/ledger-core.ts';

const NOW = Date.parse('2026-10-15T20:00:00Z');

/** A projects dir with one session whose subagents folder holds the given agents; `ageMs` is how long ago each last wrote. */
function projects(agents: { id: string; description: string; spawnDepth?: number; ageMs: number }[], session = 'sess-1') {
  const dir = mkdtempSync(join(tmpdir(), 'drift-proj-'));
  const sub = join(dir, session, 'subagents');
  mkdirSync(sub, { recursive: true });
  for (const a of agents) {
    writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: a.description, spawnDepth: a.spawnDepth ?? 1 }));
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), '{}\n');
    const t = new Date(Date.now() - a.ageMs);
    utimesSync(join(sub, `agent-${a.id}.jsonl`), t, t);
  }
  return dir;
}
const item = (id: string, text: string, extra: Partial<LedgerItem> = {}): LedgerItem => ({ id, kind: 'wip', text, closedBy: null, ...extra }) as LedgerItem;

test('runningAgents counts recently written spawnDepth-1 agents only', () => {
  const dir = projects([
    { id: 'a', description: 'Fix the widget', ageMs: 10_000 },
    { id: 'b', description: 'Finished an hour ago', ageMs: 3_600_000 },
    { id: 'c', description: 'Nested agent', spawnDepth: 2, ageMs: 5_000 },
  ]);
  assert.deepEqual(runningAgents(dir, Date.now()).map((a) => a.description), ['Fix the widget']);
  assert.deepEqual(runningAgents(dir, Date.now(), { session: 'other' }), [], 'a named session without agents has none');
  assert.equal(runningAgents(join(dir, 'nope'), Date.now()).length, 0);
});

test('untrackedAgents: an in-flight row naming the description, or holding the id, accounts for an agent; nothing else does', () => {
  const agents = [{ description: 'Fix the widget', agentType: 'x', session: 's' }, { description: 'Write docs for abcd', agentType: 'x', session: 's' }, { description: 'Mystery job', agentType: 'x', session: 's' }];
  const items = [item('w1', 'Fix the widget, then ship it'), item('abcd', 'something else'), item('q1', 'Mystery job', { queued: true })];
  assert.deepEqual(untrackedAgents(agents, items, NOW).map((a) => a.description), ['Mystery job'], 'a queued row is not an agent in flight');
  assert.equal(untrackedAgents(agents, [], NOW).length, 3, 'an empty ledger accounts for none, which is the failure this check exists for');
});

test('a row closed in the last ten minutes still accounts for its agent, an older one does not', () => {
  const a = [{ description: 'Fix the widget', agentType: 'x', session: 's' }];
  const closed = (ago: number) => item('w1', 'Fix the widget', { closedBy: { ts: new Date(NOW - ago).toISOString(), kind: 'done' } as never });
  assert.equal(untrackedAgents(a, [closed(60_000)], NOW).length, 0);
  assert.equal(untrackedAgents(a, [closed(3_600_000)], NOW).length, 1);
});

test('missingAgentHooks reads only the hook commands and reports what is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-settings-'));
  const f = join(dir, 'settings.json');
  writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent', hooks: [{ command: "node '/x/agent-dispatch.ts'" }] }] } }));
  assert.deepEqual(missingAgentHooks(f), ['agent-return.ts']);
  writeFileSync(f, JSON.stringify({ hooks: {} }));
  assert.deepEqual(missingAgentHooks(f), ['agent-dispatch.ts', 'agent-return.ts']);
  assert.deepEqual(missingAgentHooks(join(dir, 'absent.json')), ['agent-dispatch.ts', 'agent-return.ts']);
});

test('driftLine is empty with nothing untracked and names the missing hook otherwise', () => {
  assert.equal(driftLine(0, ['agent-dispatch.ts']), '');
  assert.match(driftLine(3, ['agent-dispatch.ts', 'agent-return.ts']), /^ledger drift: 3 untracked agents \(agent-dispatch\.ts and agent-return\.ts not in settings\.json/);
  assert.match(driftLine(1, []), /^ledger drift: 1 untracked agent \(start a row/);
});

test('the footer shows the drift against a real projects folder and ledger, one line and multi-line', () => {
  const vault = mkdtempSync(join(tmpdir(), 'drift-vault-'));
  const dir = projects([{ id: 'a', description: 'Untracked thing', ageMs: 5_000 }, { id: 'b', description: 'Tracked thing', ageMs: 5_000 }], 'aaaaaaaa-sess');
  writeFileSync(join(dir, 'aaaaaaaa-sess.jsonl'), '{}\n');
  const settings = join(vault, 'settings.json');
  writeFileSync(settings, '{}');
  const run = (args: string[]) => spawnSync(process.execPath, [new URL('./journal.ts', import.meta.url).pathname, ...args, '--vault', vault, '--project', 'p'], {
    encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: 'w', MAESTRO_PROJECTS_DIR: dir, MAESTRO_CLAUDE_SETTINGS: settings, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-sess', MAESTRO_EVENT_DIR: join(vault, 'Events') },
  });
  assert.equal(run(['start', 'Tracked thing', '--model', 'm', '--used', 'u']).status, 0);
  const line = run(['status', '--footer', '--line']).stdout;
  assert.match(line, /Ledger: .*\| ledger drift: 1 untracked agent \(agent-dispatch\.ts and agent-return\.ts not in settings\.json/);
  assert.match(run(['status', '--footer']).stdout, /\*\*ledger drift:\*\* 1 untracked agent/);
  assert.equal(run(['start', 'Untracked thing', '--model', 'm', '--used', 'u']).status, 0);
  assert.doesNotMatch(run(['status', '--footer', '--line']).stdout, /ledger drift/, 'once a row exists the drift is gone');
});

test('the continuity tick records the drift in its state and raises one event when it first appears', () => {
  const io = { drift: (() => { let n = 0; return () => n++; })() };
  const base: ContinuityState = { lastOk: '', error: '', last: '' };
  assert.deepEqual(cont.diff(base, { ...base, drift: 3 }).map((e) => e.summary.slice(0, 30)), ['ledger drift: 3 running agents']);
  assert.deepEqual(cont.diff({ ...base, drift: 3 }, { ...base, drift: 4 }), [], 'a standing mismatch is not re-announced');
  assert.deepEqual(cont.diff({ ...base, drift: 3 }, { ...base, drift: 0 }), []);
  assert.deepEqual(cont.diff(base, { ...base }), [], 'an unknown drift raises nothing');
  assert.equal(typeof io.drift, 'function');
});
