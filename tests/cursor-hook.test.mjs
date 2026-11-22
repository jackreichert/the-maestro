import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {readJournal} from '../scripts/ledger.mjs';
import {currentTurn, prepareTurn, startTurn} from '../scripts/turns.mjs';
import {fixture, project} from './helpers.mjs';

const conversation = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const privateMarker = 'synthetic-private-cursor-marker';

function cursorHook(f, stdin) {
  return spawnSync(process.execPath, [path.join(project, 'scripts/cursor-hook.mjs'), '--settings', f.config], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

function payload(extra = {}) {
  return {
    hook_event_name: 'preCompact',
    conversation_id: conversation,
    generation_id: generation,
    trigger: 'auto',
    prompt: privateMarker,
    attachments: [{content: privateMarker}],
    transcript_path: `/tmp/${privateMarker}`,
    user_email: `person@${privateMarker}.example`,
    assistant_message: privateMarker,
    last_assistant_message: privateMarker,
    ...extra,
  };
}

test('preCompact flushes the current turn and does not start another', (t) => {
  const f = fixture(t);
  const started = startTurn(f, conversation);
  prepareTurn(f, {session_id: conversation});
  const saved = cursorHook(f, payload({trigger: 'manual'}));
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), {});
  assert.equal(saved.stderr, '');
  assert.doesNotMatch(saved.stdout + saved.stderr, new RegExp(privateMarker));
  const state = currentTurn(f, conversation);
  assert.equal(state.turn_id, started.turn_id);
  assert.notEqual(state.turn_id, generation);
  assert.equal(state.status, 'saved');
  assert.equal(state.repair_requested, false);
  assert.equal(readJournal(f.ledger).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.ledger, 'Turns', conversation)), ['current.json']);
  assert.doesNotMatch(fs.readFileSync(path.join(f.ledger, 'Turns', conversation, 'current.json'), 'utf8'), new RegExp(privateMarker));
  const again = cursorHook(f, payload({trigger: 'auto'}));
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), {});
  assert.equal(currentTurn(f, conversation).turn_id, started.turn_id);
  assert.equal(readJournal(f.ledger).length, 1);
});

test('preCompact failure is a short user message and does not ask for repair', (t) => {
  const f = fixture(t);
  const started = startTurn(f, conversation);
  const missing = cursorHook(f, payload());
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), {user_message: 'Memory flush did not save this turn.'});
  assert.doesNotMatch(missing.stdout + missing.stderr, /repair|prepare|additionalContext|followup_message|decision/);
  assert.doesNotMatch(missing.stdout + missing.stderr, new RegExp(privateMarker));
  const state = currentTurn(f, conversation);
  assert.equal(state.turn_id, started.turn_id);
  assert.equal(state.repair_requested, false);
  assert.equal(state.status, 'missing');
  assert.equal(readJournal(f.ledger).length, 0);
});

test('preCompact does not create a turn when none exists', (t) => {
  const f = fixture(t);
  const result = cursorHook(f, payload());
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {user_message: 'Memory flush did not save this turn.'});
  assert.equal(currentTurn(f, conversation), null);
  assert.equal(readJournal(f.ledger).length, 0);
});

test('other Cursor events do not write', (t) => {
  const f = fixture(t);
  for (const hook_event_name of ['stop', 'sessionStart']) {
    const result = cursorHook(f, payload({hook_event_name}));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unsupported hook event\n');
    assert.doesNotMatch(result.stderr, new RegExp(privateMarker));
  }
  assert.equal(fs.existsSync(path.join(f.ledger, 'Turns')), false);
  assert.equal(readJournal(f.ledger).length, 0);
});

test('invalid Cursor input exits nonzero and does not echo stdin', (t) => {
  const f = fixture(t);
  const badId = cursorHook(f, payload({conversation_id: `../${privateMarker}`}));
  assert.equal(badId.status, 1);
  assert.deepEqual(JSON.parse(badId.stdout), {user_message: 'Memory flush did not save this turn.'});
  assert.doesNotMatch(badId.stdout + badId.stderr, new RegExp(privateMarker));
  assert.equal(fs.existsSync(path.join(f.ledger, 'Turns')), false);
  const broken = cursorHook(f, `{"prompt":"${privateMarker}"`);
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.doesNotMatch(broken.stdout + broken.stderr, new RegExp(privateMarker));
  assert.match(broken.stderr, /Invalid input JSON/);
});

test('beforeSubmitPrompt starts the turn that preCompact flushes', (t) => {
  const f = fixture(t);
  const started = cursorHook(f, payload({hook_event_name: 'beforeSubmitPrompt'}));
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout), {continue: true});
  assert.doesNotMatch(started.stdout + started.stderr, new RegExp(privateMarker));
  const state = currentTurn(f, conversation);
  assert.equal(state.status, 'pending');
  assert.notEqual(state.turn_id, generation);
  assert.equal(state.session_id, conversation);
  assert.doesNotMatch(fs.readFileSync(path.join(f.ledger, 'Turns', conversation, 'current.json'), 'utf8'), new RegExp(privateMarker));
  prepareTurn(f, {session_id: conversation});
  const saved = cursorHook(f, payload());
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(currentTurn(f, conversation).turn_id, state.turn_id);
  assert.equal(currentTurn(f, conversation).status, 'saved');
});

test('beforeSubmitPrompt does not block or write when the conversation id is unbound', (t) => {
  const f = fixture(t);
  const missing = cursorHook(f, payload({hook_event_name: 'beforeSubmitPrompt', conversation_id: undefined}));
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), {continue: true});
  assert.doesNotMatch(missing.stdout + missing.stderr, new RegExp(privateMarker));
  const badId = cursorHook(f, payload({hook_event_name: 'beforeSubmitPrompt', conversation_id: `../${privateMarker}`}));
  assert.equal(badId.status, 0, badId.stderr);
  assert.deepEqual(JSON.parse(badId.stdout), {continue: true});
  assert.doesNotMatch(badId.stdout + badId.stderr, new RegExp(privateMarker));
  assert.equal(fs.existsSync(path.join(f.ledger, 'Turns')), false);
});
