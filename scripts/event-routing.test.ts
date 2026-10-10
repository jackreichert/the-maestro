// Run: node --test scripts/event-routing.test.ts
// `events wait` through the real CLI with a ledger: an event goes to the window that leases its repo's work, falls back when no one does, and is never lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, claimFor } from './event-loop.ts';
import { appendEvents, mark, readInbox } from './lib/event-inbox.ts';

const SCRIPT = new URL('./event-loop.ts', import.meta.url).pathname;
const MIN = 60_000;

interface World { root: string; events: string }

/** A ledger root with the given rows (stamped relative to now, in minutes) and an empty event dir. */
function world(rows: Record<string, unknown>[]): World {
  const root = mkdtempSync(join(tmpdir(), 'event-routing-'));
  const journal = join(root, 'Projects', 'p', 'Journal');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, 'ledger.jsonl'), rows.map((r) => JSON.stringify({ ...r, ts: new Date(Date.now() + Number(r.minutes ?? 0) * MIN).toISOString(), minutes: undefined })).join('\n') + '\n');
  return { root, events: mkdtempSync(join(tmpdir(), 'event-routing-ev-')) };
}

const cli = (w: World, window: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--window', window], {
  encoding: 'utf8',
  env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: w.events, MAESTRO_WATCH_QUIET_HOURS: 'off', LEDGER_ROOT: w.root, VAULT_ROOT: w.root, MAESTRO_PROJECT: 'p', MAESTRO_STATUS_REPO_STREAMS: '' },
});
const wait = (w: World, window: string) => cli(w, window, 'events', 'wait', '--timeout-hours', '0.00003', '--poll-seconds', '0.05');
const thread = (repo: string, n: number) => ({ watch: 'prs', type: 'pr-watch', at: '2026-10-01T12:00:00.000Z', summary: `THREAD ${repo}#${n} by someone: u`, actionable: true, report: '' });

const item = { id: 'it01', kind: 'wip', repo: 'api', text: 'work on api' };
const held = (window: string, minutes: number, ttl = 60) => ({ kind: 'lease', leases: 'it01', window, ttl, minutes });

test('an event goes to the window leasing its repo and to no other window', () => {
  const w = world([item, held('w1', -1)]);
  appendEvents(w.events, [thread('acme/api', 1)]);
  const other = wait(w, 'w2');
  assert.equal(other.status, EXIT.ok, 'the non-owner gets nothing');
  assert.equal(other.stdout, '');
  assert.deepEqual(readInbox(w.events).map((e) => e.seenWindows), [[]], 'and leaves no mark that would hide it from the owner');
  const owner = wait(w, 'w1');
  assert.equal(owner.status, EXIT.actionable, owner.stderr);
  assert.match(owner.stdout, /thread prs \(pr-watch\) repo=acme\/api number=1/);
  assert.equal(wait(w, 'w1').status, EXIT.ok, 'the owner is offered it once');
  assert.deepEqual(readInbox(w.events).map((e) => [e.seenWindows, e.handled]), [[['w1'], false]], 'still unhandled, so a session start finds it with events list');
});

test('a lapsed lease hands the event to the other window; nothing is dropped', () => {
  const w = world([item, held('w1', -180, 60)]);
  appendEvents(w.events, [thread('acme/api', 2)]);
  const r = wait(w, 'w2');
  assert.equal(r.status, EXIT.actionable, r.stderr);
  assert.match(r.stdout, /number=2/);
  assert.equal(wait(w, 'w1').status, EXIT.ok, 'the window that took it keeps it; the dead owner is not offered it too');
});

test('an event for a repo nobody leases goes to the first window that asks, and only to it', () => {
  const w = world([item, held('w1', -1)]);
  appendEvents(w.events, [thread('acme/web', 3)]);
  assert.equal(wait(w, 'w2').status, EXIT.actionable);
  assert.equal(wait(w, 'w1').status, EXIT.ok);
});

test('with no ledger configured every event is unowned and the first window to ask takes it', () => {
  const w = world([item, held('w1', -1)]);
  appendEvents(w.events, [thread('acme/api', 4)]);
  const bare = (window: string) => spawnSync(process.execPath, [SCRIPT, 'events', 'wait', '--window', window, '--timeout-hours', '0.00003', '--poll-seconds', '0.05'], {
    encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: w.events, LEDGER_ROOT: '', VAULT_ROOT: '' },
  });
  assert.equal(bare('w2').status, EXIT.actionable);
  assert.equal(bare('w1').status, EXIT.ok);
});

test('events list shows every unhandled event to every window; --json names the owner and --unseen is per window', () => {
  const w = world([item, held('w1', -1)]);
  appendEvents(w.events, [thread('acme/api', 5), thread('acme/web', 6)]);
  const asOther = JSON.parse(cli(w, 'w2', 'events', 'list', '--json').stdout) as { fields: { number: number }; owner?: string }[];
  assert.deepEqual(asOther.map((e) => [e.fields.number, e.owner]), [[5, 'w1'], [6, undefined]]);
  assert.equal(wait(w, 'w1').status, EXIT.actionable);
  const unseenBy = (window: string) => (JSON.parse(cli(w, window, 'events', 'list', '--unseen', '--json').stdout) as { fields: { number: number } }[]).map((e) => e.fields.number);
  assert.deepEqual(unseenBy('w1'), [], 'w1 took event 5 (its own) and event 6 (unowned, first asker)');
  assert.deepEqual(unseenBy('w2'), [5, 6], 'w2 has seen neither');
});

test('two windows that both read an unowned event free: only the one whose mark is first keeps it', () => {
  const w = world([]);
  appendEvents(w.events, [thread('acme/web', 7)]);
  const rival = (): void => { mark(w.events, 'seen', readInbox(w.events).map((e) => e.id), Date.now(), 'w1'); };
  const mine = claimFor(w.events, 'w2', rival);   // w1's mark lands after w2 read the event free but before w2 marks it
  assert.deepEqual(mine.map((e) => e.fields.number), [], 'w2 lost the race and prints nothing');
  assert.deepEqual(readInbox(w.events).map((e) => [e.seenBy, e.seenWindows]), [['w1', ['w1', 'w2']]], 'both marked; w1\'s is first in the file');
  assert.deepEqual(claimFor(w.events, 'w1').map((e) => e.fields.number), [], 'and w1 is not offered it a second time');
});
