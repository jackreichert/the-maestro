import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {readJournal} from '../scripts/ledger.mjs';
import {currentTurn, prepareTurn, startTurn} from '../scripts/turns.mjs';
import {fixture, project} from './helpers.mjs';

const session = '11111111-1111-4111-8111-111111111111';
const privateMarker = 'synthetic-private-grok-marker';

function grokHook(f, stdin, env = {}) {
  return spawnSync(process.execPath, [path.join(project, 'scripts/grok-hook.mjs'), '--settings', f.config], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: {...process.env, ...env},
  });
}

function payload(extra = {}) {
  return {
    hookEventName: 'pre_compact',
    sessionId: session,
    cwd: '/tmp/project',
    workspaceRoot: '/tmp/project',
    timestamp: '2026-04-14T12:00:00Z',
    permissionMode: 'default',
    prompt: privateMarker,
    transcript_path: `/tmp/${privateMarker}`,
    lastAssistantMessage: privateMarker,
    ...extra,
  };
}

test('PreCompact flushes the current turn and does not start another', (t) => {
  const f = fixture(t);
  const started = startTurn(f, session);
  prepareTurn(f, {session_id: session});
  const saved = grokHook(f, payload({permissionMode: 'auto'}));
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.stdout, '');
  assert.equal(saved.stderr, '');
  const state = currentTurn(f, session);
  assert.equal(state.turn_id, started.turn_id);
  assert.equal(state.status, 'saved');
  assert.equal(state.repair_requested, false);
  assert.equal(readJournal(f.ledger).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.ledger, 'Turns', session)), ['current.json']);
  assert.doesNotMatch(fs.readFileSync(path.join(f.ledger, 'Turns', session, 'current.json'), 'utf8'), new RegExp(privateMarker));
  const again = grokHook(f, payload());
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '');
  assert.equal(currentTurn(f, session).turn_id, started.turn_id);
  assert.equal(readJournal(f.ledger).length, 1);
});

test('PreCompact failure writes nothing to stdout and does not ask for repair', (t) => {
  const f = fixture(t);
  const started = startTurn(f, session);
  const missing = grokHook(f, payload());
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Memory flush did not save this turn/);
  assert.doesNotMatch(missing.stdout + missing.stderr, /repair|prepare|additionalContext|followup_message|decision|user_message/);
  assert.doesNotMatch(missing.stdout + missing.stderr, new RegExp(privateMarker));
  const state = currentTurn(f, session);
  assert.equal(state.turn_id, started.turn_id);
  assert.equal(state.repair_requested, false);
  assert.equal(state.status, 'missing');
  assert.equal(readJournal(f.ledger).length, 0);
});

test('PreCompact does not create a turn when none exists', (t) => {
  const f = fixture(t);
  const result = grokHook(f, payload());
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(currentTurn(f, session), null);
  assert.equal(readJournal(f.ledger).length, 0);
});

test('other Grok events do not write', (t) => {
  const f = fixture(t);
  for (const hookEventName of ['stop', 'Stop', 'PreCompact', 'PostCompact', 'UserPromptSubmit']) {
    const result = grokHook(f, payload({hookEventName}));
    assert.equal(result.status, 1, hookEventName);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unsupported hook event\n');
    assert.doesNotMatch(result.stderr, new RegExp(privateMarker));
  }
  assert.equal(fs.existsSync(path.join(f.ledger, 'Turns')), false);
  assert.equal(readJournal(f.ledger).length, 0);
});

test('a missing or unbound session id fails closed and does not echo stdin', (t) => {
  const f = fixture(t);
  const missing = grokHook(f, payload({sessionId: undefined}), {GROK_SESSION_ID: session});
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.doesNotMatch(missing.stderr, new RegExp(privateMarker));
  assert.doesNotMatch(missing.stderr, new RegExp(session));
  const badId = grokHook(f, payload({sessionId: `../${privateMarker}`}));
  assert.equal(badId.status, 1);
  assert.equal(badId.stdout, '');
  assert.doesNotMatch(badId.stdout + badId.stderr, new RegExp(privateMarker));
  const broken = grokHook(f, `{"prompt":"${privateMarker}"`);
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.doesNotMatch(broken.stdout + broken.stderr, new RegExp(privateMarker));
  assert.match(broken.stderr, /Invalid input JSON/);
  assert.equal(fs.existsSync(path.join(f.ledger, 'Turns')), false);
  assert.equal(readJournal(f.ledger).length, 0);
});

test('user_prompt_submit starts the turn that pre_compact flushes', (t) => {
  const f = fixture(t);
  const started = grokHook(f, payload({hookEventName: 'user_prompt_submit'}));
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '');
  assert.doesNotMatch(started.stdout + started.stderr, new RegExp(privateMarker));
  const state = currentTurn(f, session);
  assert.equal(state.status, 'pending');
  assert.equal(state.session_id, session);
  assert.doesNotMatch(fs.readFileSync(path.join(f.ledger, 'Turns', session, 'current.json'), 'utf8'), new RegExp(privateMarker));
  prepareTurn(f, {session_id: session});
  const saved = grokHook(f, payload());
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.stdout, '');
  assert.equal(currentTurn(f, session).turn_id, state.turn_id);
  assert.equal(currentTurn(f, session).status, 'saved');
});

test('user_prompt_submit fails closed without a bound session id', (t) => {
  const f = fixture(t);
  const missing = grokHook(f, payload({hookEventName: 'user_prompt_submit', sessionId: undefined}), {GROK_SESSION_ID: session});
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Memory turn did not start/);
  assert.doesNotMatch(missing.stdout + missing.stderr, /repair|decision|user_message/);
  assert.doesNotMatch(missing.stdout + missing.stderr, new RegExp(privateMarker));
  assert.doesNotMatch(missing.stderr, new RegExp(session));
  const badId = grokHook(f, payload({hookEventName: 'user_prompt_submit', sessionId: `../${privateMarker}`}));
  assert.equal(badId.status, 1);
  assert.equal(badId.stdout, '');
  assert.doesNotMatch(badId.stdout + badId.stderr, new RegExp(privateMarker));
  assert.equal(fs.existsSync(path.join(f.ledger, 'Turns')), false);
});
