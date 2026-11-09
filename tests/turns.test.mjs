import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {prepare, readJournal} from '../scripts/ledger.mjs';
import {readJson} from '../scripts/storage.mjs';
import {currentTurn, finishTurn, memoryHealth, prepareTurn, startTurn} from '../scripts/turns.mjs';
import {cliPath as cli, fixture, memoryCli} from './helpers.mjs';
const session = 'session-guard';

function run(f, event, extra = {}) {
  return memoryCli(f, 'hook', [], {hook_event_name: event, session_id: session, ...extra});
}

function checkpoint(f, overrides = {}) {
  return prepareTurn(f, {session_id: session, ...overrides});
}

test('prompt hook injects current-turn commands without persisting prompt or transcript data', (t) => {
  const f = fixture(t);
  const result = run(f, 'UserPromptSubmit', {prompt: 'synthetic-private-prompt-marker',
    transcript_path: '/not-readable', last_assistant_message: 'synthetic-private-message-marker'});
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'UserPromptSubmit');
  const state = currentTurn(f, session);
  assert.match(output.additionalContext, new RegExp(state.turn_id));
  assert.ok(output.additionalContext.includes(cli));
  assert.ok(output.additionalContext.includes(f.config));
  assert.doesNotMatch(JSON.stringify(state) + result.stdout, /synthetic-private/);
  assert.equal(memoryHealth(f, session), 'Memory pending');
  assert.equal(readJournal(f.ledger).length, 0);
});

test('missing checkpoint gets exactly one persisted automatic repair attempt', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  const first = run(f, 'Stop');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  assert.match(JSON.parse(first.stdout).reason, /Do this automatically/);
  assert.equal(currentTurn(f, session).repair_requested, true);
  for (const extra of [{stop_hook_active: true}, {}, {stop_hook_active: true}]) {
    const repeated = run(f, 'Stop', extra);
    assert.equal(repeated.status, 1);
    assert.doesNotMatch(repeated.stdout, /"decision"/);
    assert.match(repeated.stdout, /missing/);
  }
  assert.equal(readJournal(f.ledger).length, 0);
  assert.equal(memoryHealth(f, session), 'Memory checkpoint missing');
});

test('existing stop-hook continuation is never blocked again', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  const result = run(f, 'Stop', {stop_hook_active: true});
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /"decision"/);
});

test('repair checkpoint binds to current turn and repeated Stop does not duplicate writes', (t) => {
  const f = fixture(t);
  const state = startTurn(f, session);
  run(f, 'Stop');
  const payload = checkpoint(f);
  assert.equal(payload.turn_id, state.turn_id);
  for (const event of ['Stop', 'PreCompact', 'Stop']) {
    const result = run(f, event, {stop_hook_active: true});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /saved; 1 current-turn receipts; 0 incomplete/);
    assert.doesNotMatch(result.stdout, /"decision"/);
  }
  assert.equal(readJournal(f.ledger).length, 1);
  assert.equal(memoryHealth(f, session), 'Memory saved');
});

test('old checkpoints and wrong-turn deltas cannot satisfy a new turn', (t) => {
  const f = fixture(t);
  const old = startTurn(f, session);
  checkpoint(f);
  assert.equal(run(f, 'Stop').status, 0);
  const fresh = startTurn(f, session);
  assert.notEqual(fresh.turn_id, old.turn_id);
  assert.throws(() => checkpoint(f, {turn_id: old.turn_id}), /does not match/);
  const result = run(f, 'Stop');
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  assert.match(JSON.parse(result.stdout).reason, /0 current-turn receipts/);
  assert.equal(readJournal(f.ledger).length, 1);
});

test('PreCompact saves prepared deltas without blocking and missing capture remains visible', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  const missing = run(f, 'PreCompact');
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stdout, /"decision"/);
  assert.equal(currentTurn(f, session).repair_requested, false);
  checkpoint(f);
  const saved = run(f, 'PreCompact');
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(memoryHealth(f, session), 'Memory saved');
});

test('StopFailure flushes prepared work, records interruption and never ingests error details', (t) => {
  const f = fixture(t);
  const old = startTurn(f, session);
  checkpoint(f);
  const failed = run(f, 'StopFailure', {error: 'rate_limit', error_details: 'synthetic-error-detail',
    last_assistant_message: 'synthetic-api-error'});
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stdout, /"decision"|synthetic/);
  assert.equal(readJournal(f.ledger).length, 1);
  assert.equal(currentTurn(f, session).status, 'interrupted');
  assert.equal(memoryHealth(f, session), 'Memory interrupted');
  const next = startTurn(f, session);
  assert.equal(next.previous_gaps, 1);
  const archived = readJson(f.ledger, `Turns/${session}/${old.turn_id}.json`);
  assert.equal(archived.status, 'interrupted');
  assert.doesNotMatch(JSON.stringify(archived), /synthetic/);
  checkpoint(f);
  assert.equal(run(f, 'Stop').status, 0);
  assert.equal(memoryHealth(f, session), 'Memory saved; 1 earlier gaps');
});

test('failed turns without prepared work do not invent a checkpoint', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  const failed = run(f, 'StopFailure');
  assert.equal(failed.status, 1);
  assert.equal(readJournal(f.ledger).length, 0);
  assert.equal(currentTurn(f, session).status, 'interrupted');
});

test('page conflicts stay failed after the bounded repair attempt; ledger success is not enough', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'User edit');
  checkpoint(f, {pages: [{surface: 'podium', path: 'Podium/README.md', expected_sha256: null,
    changes: [{before: '', after: 'New page'}]}]});
  const blocked = run(f, 'Stop');
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  assert.equal(currentTurn(f, session).status, 'write-failed');
  assert.equal(readJournal(f.ledger).length, 1);
  const retry = run(f, 'Stop', {stop_hook_active: true});
  assert.equal(retry.status, 1);
  assert.doesNotMatch(retry.stdout, /"decision"/);
  assert.equal(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8'), 'User edit');
  assert.equal(memoryHealth(f, session), 'Memory write failed');
});

test('flush exceptions persist failure health and do not steal locks', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  checkpoint(f);
  fs.mkdirSync(path.join(f.vault, '.writer.lock'));
  const result = finishTurn(f, {hook_event_name: 'Stop', session_id: session});
  assert.equal(result.block, true);
  assert.match(result.failure, /Writer lock held/);
  assert.equal(memoryHealth(f, session), 'Memory write failed');
  assert.ok(fs.existsSync(path.join(f.vault, '.writer.lock')));
  assert.equal(readJournal(f.ledger).length, 0);
});

test('untracked sessions flush legacy prepared work without claiming current-turn coverage', (t) => {
  const f = fixture(t);
  prepare(f, {session_id: session, turn_id: 'legacy-turn'});
  const result = run(f, 'Stop');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /untracked turn; 1 historical/);
  assert.doesNotMatch(result.stdout, /"decision"/);
  assert.equal(readJournal(f.ledger).length, 1);
  assert.equal(memoryHealth(f, session), 'Memory untracked');
});

test('session isolation, invalid identities and malformed turn state fail explicitly', (t) => {
  const f = fixture(t);
  startTurn(f, session);
  checkpoint(f);
  const other = run(f, 'Stop', {session_id: 'other'});
  assert.equal(other.status, 1);
  assert.equal(readJournal(f.ledger).length, 0);
  assert.throws(() => startTurn(f, '../escape'), /Invalid session ID/);
  fs.writeFileSync(path.join(f.ledger, `Turns/${session}/current.json`), '{"version":1}\n');
  assert.throws(() => memoryHealth(f, session), /Missing required/);
  assert.equal(run(f, 'Stop').status, 1);
});
