import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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
  assert.match(output.additionalContext, /Podium is the single source of truth for persistent current state/);
  assert.match(output.additionalContext, /instead of maintaining competing status files/);
  assert.match(output.additionalContext, /question in chat, question forms or Podium, include context, concrete options and material tradeoffs, plus a recommendation and why/);
  assert.match(output.additionalContext, /factual clarification with no defensible recommendation/);
  assert.match(output.additionalContext, /changes to active PRs, blockers, next actions or open questions/);
  assert.match(output.additionalContext, /include revision-checked Podium patches in pages/);
  assert.match(output.additionalContext, /ledger events alone do not update Podium/);
  assert.match(output.additionalContext, /Refresh edited-page updated dates and affected landing\/stream summaries, status, blockers and next actions together/);
  assert.match(output.additionalContext, /preserve rank and unrelated edits/);
  assert.match(output.additionalContext, /Keep pass, partial and not-run distinct/);
  assert.match(output.additionalContext, /Do not ask permission for routine coupled corrections backed by verified evidence/);
  assert.match(output.additionalContext, /only PRs in the work currently in progress, not every open PR/);
  assert.match(output.additionalContext, /questions with their four-character short_ref/);
  assert.match(output.additionalContext, /full event IDs for resolves/);
  assert.match(output.additionalContext, /read back the affected Podium sections/);
  assert.match(output.additionalContext, /Check every receipt, including errors and ledger\/page\/index outcomes/);
  assert.match(output.additionalContext, /Keep successful checkpoints silent in chat; the footer is enough/);
  assert.doesNotMatch(output.additionalContext, /"topics":\[\],"events":\[\],"pages":\[\]/);
  assert.match(output.additionalContext, /No code changes does not mean no memory changes/);
  assert.match(output.additionalContext, /Compare the saved events\/pages with the actual turn/);
  assert.doesNotMatch(JSON.stringify(state) + result.stdout, /synthetic-private/);
  assert.equal(memoryHealth(f, session), 'Memory pending');
  assert.equal(readJournal(f.ledger).length, 0);
});

test('missing checkpoint gets exactly one persisted automatic repair attempt', (t) => {
  const f = fixture(t);
  const prompt = run(f, 'UserPromptSubmit');
  const instructions = JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext;
  const state = currentTurn(f, session);
  const first = run(f, 'Stop');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  const reason = JSON.parse(first.stdout).reason;
  assert.ok(reason.length < instructions.length * 0.6, 'Repair must not replay the full prompt instructions');
  assert.ok(reason.includes(cli) && reason.includes(f.config));
  assert.ok(reason.includes(state.turn_id) && reason.includes(session));
  assert.match(reason, /prepare/);
  assert.match(reason, /flush/);
  assert.match(reason, /Metadata-only is valid only when nothing relevant remains unsaved/);
  assert.doesNotMatch(reason, /"topics":\[\],"events":\[\],"pages":\[\]/);
  assert.match(reason, /No code changes does not mean no memory changes/);
  assert.match(reason, /Podium pages and include revision-checked patches/);
  assert.match(reason, /permissions/);
  assert.match(reason, /receipts/);
  assert.match(reason, /Keep successful checkpoints silent in chat; the footer is enough/);
  assert.doesNotMatch(reason, /For every user question|Podium is the single source/);
  assert.equal(first.stderr, '', 'Missing capture should use the repair decision, not a second error channel');
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
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(readJournal(f.ledger).length, 1);
  assert.match(memoryHealth(f, session), /^Muninn [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
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

test('last checkpoint records acknowledgement time, survives new turns, and does not advance on repeats or failures', (t) => {
  const f = fixture(t);
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-11-10T11:36:00Z')});
  startTurn(f, session);
  checkpoint(f);
  t.mock.timers.tick(1000);
  finishTurn(f, {hook_event_name: 'Stop', session_id: session});
  assert.equal(currentTurn(f, session).last_checkpoint_at, '2026-11-10T11:36:01.000Z');
  const savedLabel = memoryHealth(f, session);
  assert.match(savedLabel, /^Muninn [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  t.mock.timers.tick(60000);
  finishTurn(f, {hook_event_name: 'Stop', session_id: session});
  assert.equal(currentTurn(f, session).last_checkpoint_at, '2026-11-10T11:36:01.000Z');
  startTurn(f, session);
  assert.equal(memoryHealth(f, session), `${savedLabel}; Memory pending`);
  finishTurn(f, {hook_event_name: 'StopFailure', session_id: session});
  assert.equal(memoryHealth(f, session), `${savedLabel}; Memory interrupted`);
});

test('checkpoint display follows the local timezone and daylight saving without displaying stored gaps', (t) => {
  const f = fixture(t);
  const state = startTurn(f, session);
  const script = `import {memoryHealth} from ${JSON.stringify(new URL('../scripts/turns.mjs', import.meta.url).href)};
    console.log(memoryHealth(${JSON.stringify({ledger: f.ledger})}, ${JSON.stringify(session)}));`;
  for (const [timestamp, zone, expected] of [
    ['2026-11-10T11:36:01Z', 'Asia/Jerusalem', 'Nov 10 13:36'],
    ['2026-07-10T11:36:01Z', 'Asia/Jerusalem', 'Jul 10 14:36'],
    ['2026-11-10T01:36:01Z', 'America/New_York', 'Nov 9 20:36'],
  ]) {
    fs.writeFileSync(path.join(f.ledger, `Turns/${session}/current.json`),
      JSON.stringify({...state, status: 'saved', last_checkpoint_at: timestamp, previous_gaps: 3}));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      {encoding: 'utf8', env: {...process.env, TZ: zone}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `Muninn ${expected}`);
    assert.equal(currentTurn(f, session).previous_gaps, 3);
  }
});

test('legacy saved states show unknown time rather than inventing a checkpoint timestamp', (t) => {
  const f = fixture(t);
  const state = startTurn(f, session);
  delete state.last_checkpoint_at;
  state.status = 'saved';
  fs.writeFileSync(path.join(f.ledger, `Turns/${session}/current.json`), JSON.stringify(state));
  assert.equal(memoryHealth(f, session), 'Muninn unknown');
  fs.writeFileSync(path.join(f.ledger, `Turns/${session}/current.json`),
    JSON.stringify({...state, last_checkpoint_at: 'invalid'}));
  assert.throws(() => memoryHealth(f, session), /Invalid last checkpoint timestamp/);
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
  assert.match(memoryHealth(f, session), /^Muninn [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
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
  assert.match(memoryHealth(f, session), /^Muninn [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  assert.doesNotMatch(memoryHealth(f, session), /gaps/);
  assert.equal(currentTurn(f, session).previous_gaps, 1);
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
