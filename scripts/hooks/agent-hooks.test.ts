// Run: node --test scripts/hooks/agent-hooks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, isInFlight, isQueued } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { foldLeases, liveLease } from '../lib/journal/leases.ts';
import { liveAgent, lapsedRequeues } from '../lib/journal/lease-requeue.ts';
import { agentReturned } from './agent-return.ts';
import { dispatch } from './agent-dispatch.ts';
import { requeueEnding } from './session-end-requeue.ts';
import type { HookLedger } from './ledger-hook.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-10-13T08:00:00Z');
const SESSION = 'abcdef123456-0000';
const WIN = 'abcdef123456';

/** An in-memory ledger whose clock the test moves. */
function memory(seed: LedgerRow[] = []): HookLedger & { rows: LedgerRow[]; at: number; briefs: { text: string; title: string }[] } {
  const m = { rows: [...seed], at: T0, briefs: [] as { text: string; title: string }[], readLedger: () => m.rows, append: (r: LedgerRow[]) => { m.rows.push(...r); }, now: () => m.at, newId: (ex: { id?: string }[]) => `h${ex.length}`,
    saveBrief: (text: string, title: string, id: string) => { m.briefs.push({ text, title }); return `/briefs/${id}.md`; } };
  return m;
}
const items = (rows: LedgerRow[]) => fold(rows, null).items;
const call = (description: string, prompt = 'do it') => ({ session_id: SESSION, tool_input: { description, prompt, subagent_type: 'general-purpose' } });

test('a dispatch with no matching row opens an in-flight row with a lease and marks an agent out', () => {
  const led = memory();
  dispatch(call('Build the widget'), led);
  const open = items(led.rows).filter(isInFlight);
  assert.equal(open.length, 1);
  assert.equal(open[0].text, 'Build the widget');
  assert.equal(open[0].hookOpened, true);
  assert.equal(liveLease(foldLeases(led.rows), open[0].id as string, led.at)?.holder, WIN);
  assert.equal(liveAgent(led.rows, open[0].id as string, led.at), true);
  assert.equal(open[0].nextStep, 'agent running: Build the widget');
});

test('a dispatch about a row this window already leased reuses it, by id in the prompt or the description in its text', () => {
  const led = memory([{ id: 'ab12', kind: 'wip', ts: new Date(T0).toISOString(), date: '2026-10-13', text: 'Build the widget', window: WIN, leaseTtl: 60 } as LedgerRow]);
  dispatch(call('Build the widget'), led);
  dispatch(call('something else entirely', 'finish ab12 please'), led);
  assert.equal(items(led.rows).filter((i) => i.kind === 'wip').length, 1, 'no second row was opened');
  assert.equal(led.rows.filter((r) => r.agent === true).length, 2);
});

test('a row leased by another window is not taken over: the dispatch opens its own row', () => {
  const led = memory([{ id: 'ab12', kind: 'wip', ts: new Date(T0).toISOString(), date: '2026-10-13', text: 'Build the widget', window: 'otherwin', leaseTtl: 60 } as LedgerRow]);
  dispatch(call('Build the widget'), led);
  assert.equal(items(led.rows).filter((i) => i.kind === 'wip').length, 2);
});

test('the stop marks the row returned, verify, and shortens its lease so an unverified hand-back requeues', () => {
  const led = memory();
  dispatch(call('Build the widget'), led);
  const id = items(led.rows).find((i) => i.kind === 'wip')?.id as string;
  led.at = T0 + 10 * 60_000;
  const out = agentReturned({ session_id: SESSION, agent_type: 'general-purpose' }, led);
  assert.equal(out.length, 2);
  const row = items(led.rows).find((i) => i.id === id);
  assert.equal(row?.nextStep, 'returned, verify');
  assert.ok(row && isInFlight(row), 'the hook never closes the row: the dispatcher verifies');
  assert.equal(liveAgent(led.rows, id, led.at), false);
  const later = led.at + 61 * 60_000;
  assert.equal(lapsedRequeues(led.rows, items(led.rows), later).length, 1, 'verify window passed with nobody touching it');
  assert.equal(lapsedRequeues(led.rows, items(led.rows), led.at + 30 * 60_000).length, 0, 'inside the verify window it stays');
});

test('two agents on one row: the first stop leaves the second still counted as running; a stop with nothing open writes nothing', () => {
  const led = memory();
  dispatch(call('Build the widget'), led);
  dispatch(call('Build the widget'), led);
  const id = items(led.rows).find((i) => i.kind === 'wip')?.id as string;
  agentReturned({ session_id: SESSION, agent_type: 'general-purpose' }, led);
  assert.equal(liveAgent(led.rows, id, led.at), true);
  agentReturned({ session_id: SESSION, agent_type: 'general-purpose' }, led);
  assert.equal(liveAgent(led.rows, id, led.at), false);
  const before = led.rows.length;
  assert.deepEqual(agentReturned({ session_id: SESSION, agent_type: 'general-purpose' }, led), []);
  assert.deepEqual(agentReturned({ session_id: 'otherwindow-1', agent_type: 'x' }, led), []);
  assert.equal(led.rows.length, before);
});

test('two same-type agents on different rows: a stop that cannot say which one writes nothing, so neither row is requeued under its agent', () => {
  const led = memory();
  dispatch(call('Build the widget'), led);
  dispatch(call('Build the gadget'), led);
  const before = led.rows.length;
  assert.deepEqual(agentReturned({ session_id: SESSION, agent_type: 'general-purpose' }, led), []);
  assert.equal(led.rows.length, before);
  assert.deepEqual(lapsedRequeues(led.rows, items(led.rows), T0 + 85 * 60_000), [], 'both agents are still counted as out');
});

test('a re-dispatch on a row whose lease lapsed reuses it instead of opening a duplicate', () => {
  const led = memory([{ id: 'ab12', kind: 'wip', ts: new Date(T0).toISOString(), date: '2026-10-13', text: 'Build the widget', window: WIN, leaseTtl: 60 } as LedgerRow]);
  led.at = T0 + 3 * 60 * 60_000;
  dispatch(call('fix round', 'redo ab12'), led);
  assert.equal(items(led.rows).filter((i) => i.kind === 'wip').length, 1);
  assert.equal(liveAgent(led.rows, 'ab12', led.at), true);
});

test('a lapsed lease does not requeue a row whose agent is still running', () => {
  const led = memory();
  dispatch(call('Build the widget'), led);
  led.at = T0 + 3 * 60 * 60_000;
  assert.deepEqual(lapsedRequeues(led.rows, items(led.rows), led.at), []);
  assert.equal(lapsedRequeues(led.rows, items(led.rows), T0 + 5 * 60 * 60_000).length, 1, 'past the agent ttl it is abandoned');
});

test('session end requeues the ending window\'s leased rows and releases them', () => {
  const led = memory();
  dispatch(call('Build the widget'), led);
  led.at = T0 + 5 * 60_000;
  requeueEnding({ session_id: SESSION }, led);
  const row = items(led.rows).find((i) => i.kind === 'wip');
  assert.ok(row && isQueued(row));
  assert.equal(liveLease(foldLeases(led.rows), row?.id as string, led.at), undefined);
  const n = led.rows.length;
  requeueEnding({ session_id: SESSION }, led);
  assert.equal(led.rows.length, n, 'a second end writes nothing');
});

// The real entry points: stdin JSON in, nothing on stdout, exit 0 always, well under 300 ms in-process.
function runHook(file: string, stdin: string, vault: string): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, file), '--vault', vault, '--project', 'hook-proj'], { input: stdin, encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: '' }, timeout: 15_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t };
}

test('the real hooks write the ledger, print nothing, and fail open on bad input or an unwritable vault', () => {
  const vault = mkdtempSync(join(tmpdir(), 'agent-hooks-'));
  try {
    const ledger = join(vault, 'Projects', 'hook-proj', 'Journal', 'ledger.jsonl');
    const d = runHook('agent-dispatch.ts', JSON.stringify(call('Build the widget')), vault);
    assert.equal(d.status, 0, d.stderr);
    assert.equal(d.stdout, '');
    assert.equal(readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length, 4, 'wip, brief, marked lease and next');
    const r = runHook('agent-return.ts', JSON.stringify({ session_id: SESSION, agent_type: 'general-purpose' }), vault);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length, 6);
    const e = runHook('session-end-requeue.ts', JSON.stringify({ session_id: SESSION }), vault);
    assert.equal(e.status, 0, e.stderr);
    assert.equal(readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length, 8, 'queue and unlease');
    for (const f of ['agent-dispatch.ts', 'agent-return.ts', 'session-end-requeue.ts']) {
      const bad = runHook(f, 'not json {{{', vault);
      assert.equal(bad.status, 0);
      assert.equal(bad.stdout, '');
    }
    const broken = join(vault, 'file-not-dir');
    writeFileSync(broken, 'x');
    const unwritable = runHook('agent-dispatch.ts', JSON.stringify(call('x')), broken);
    assert.equal(unwritable.status, 0, 'a broken ledger location must not block the dispatch');
    assert.equal(unwritable.stdout, '');
    assert.match(unwritable.stderr, /agent-dispatch hook:/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a dispatch against a large ledger stays under the 300 ms budget (hook work, node startup excluded)', () => {
  const rows: LedgerRow[] = Array.from({ length: 6000 }, (_, n) => ({ id: `r${n}`, ts: new Date(T0 - n * 60_000).toISOString(), date: '2026-10-12', kind: n % 3 ? 'note' : 'done', text: `row ${n} with some typical amount of descriptive text in it` }) as LedgerRow);
  const led = memory(rows);
  const t = process.hrtime.bigint();
  dispatch(call('Build the widget'), led);
  agentReturned({ session_id: SESSION, agent_type: 'general-purpose' }, led);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 300, `dispatch plus return took ${ms.toFixed(0)} ms`);
});

test('a dispatch that opens a row keeps the prompt as its brief; one that reuses a row does not write another', () => {
  const led = memory();
  dispatch(call('Build the widget', 'Full prompt: build it, then verify.'), led);
  const wip = led.rows.find((r) => r.kind === 'wip');
  const brief = led.rows.find((r) => r.kind === 'brief');
  assert.equal(brief?.briefs, wip?.id);
  assert.equal(brief?.brief, `/briefs/${wip?.id}.md`);
  assert.deepEqual(led.briefs, [{ text: 'Full prompt: build it, then verify.', title: 'Build the widget' }]);
  assert.equal(items(led.rows).find((i) => i.id === wip?.id)?.brief, brief?.brief, 'the fold carries the brief on the item');
  dispatch(call('Build the widget', 'Second prompt'), led);
  assert.equal(led.rows.filter((r) => r.kind === 'brief').length, 1, 'the reused row keeps its first brief');
});

test('a prompt that cannot be saved still opens the row, without a brief row', () => {
  const led = memory();
  led.saveBrief = () => null;
  dispatch(call('Build the widget', 'p'), led);
  assert.equal(led.rows.filter((r) => r.kind === 'wip').length, 1);
  assert.equal(led.rows.filter((r) => r.kind === 'brief').length, 0);
});

test('a call a subagent makes itself (agent_id set) is not tracked: only the orchestrator session counts', () => {
  const led = memory();
  assert.deepEqual(dispatch({ ...call('Nested job'), agent_id: 'a1b2c3' }, led), []);
  assert.equal(led.rows.length, 0);
});

test('the real hook saves the prompt under the ledger Briefs folder', () => {
  const vault = mkdtempSync(join(tmpdir(), 'agent-hooks-brief-'));
  try {
    const d = runHook('agent-dispatch.ts', JSON.stringify(call('Build the widget', 'Prompt body for the agent.')), vault);
    assert.equal(d.status, 0, d.stderr);
    const dir = join(vault, 'Projects', 'hook-proj', 'Journal', 'Briefs');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(dir, files[0] as string), 'utf8'), 'Prompt body for the agent.\n');
    const secret = runHook('agent-dispatch.ts', JSON.stringify(call('Another job', 'use key AKIAIOSFODNN7EXAMPLE now')), vault);
    assert.equal(secret.status, 0);
    assert.equal(readdirSync(dir).length, 1, 'a prompt that looks like a secret is not saved');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('the real dispatch hook ignores a call that carries agent_id: nothing is written', () => {
  const vault = mkdtempSync(join(tmpdir(), 'agent-hooks-nested-'));
  try {
    const r = runHook('agent-dispatch.ts', JSON.stringify({ ...call('Nested job'), agent_id: 'a1b2c3' }), vault);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(vault, 'Projects', 'hook-proj', 'Journal', 'ledger.jsonl')), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
