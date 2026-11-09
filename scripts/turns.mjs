import crypto from 'node:crypto';
import {flush, prepare} from './ledger.mjs';
import {identifier} from './schema.mjs';
import {ensureDirectory, keys, readJson, requireValue, scopedPath, withLock, writeJson} from './storage.mjs';

const states = ['pending', 'saved', 'missing', 'write-failed', 'interrupted'];

function directory(session) {
  requireValue(identifier(session), 'Invalid session ID');
  return `Turns/${session}`;
}

export function currentTurn(context, session) {
  const state = readJson(context.ledger, `${directory(session)}/current.json`);
  if (!state) return null;
  keys(state, ['version', 'session_id', 'turn_id', 'started_at', 'status', 'repair_requested', 'previous_gaps'],
    ['version', 'session_id', 'turn_id', 'started_at', 'status', 'repair_requested', 'previous_gaps']);
  requireValue(state.version === 1 && state.session_id === session && identifier(state.turn_id)
    && typeof state.started_at === 'string' && Number.isFinite(Date.parse(state.started_at))
    && states.includes(state.status) && typeof state.repair_requested === 'boolean'
    && Number.isSafeInteger(state.previous_gaps) && state.previous_gaps >= 0, 'Invalid turn tracking state');
  return state;
}

function withSession(context, session, action) {
  const relative = directory(session);
  withLock(context.ledger, () => ensureDirectory(context.ledger, relative));
  return withLock(scopedPath(context.ledger, relative), action);
}

function saveTurn(context, state) {
  writeJson(context.ledger, `${directory(state.session_id)}/current.json`, state);
}

export function startTurn(context, session) {
  return withSession(context, session, () => {
    const previous = currentTurn(context, session);
    if (previous) writeJson(context.ledger, `${directory(session)}/${previous.turn_id}.json`, previous);
    const state = {
      version: 1,
      session_id: session,
      turn_id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      status: 'pending',
      repair_requested: false,
      previous_gaps: (previous?.previous_gaps ?? 0) + (previous && previous.status !== 'saved' ? 1 : 0),
    };
    saveTurn(context, state);
    return state;
  });
}

export function prepareTurn(context, input) {
  return withSession(context, input.session_id, () => {
    const state = currentTurn(context, input.session_id);
    if (state) {
      requireValue(input.turn_id === undefined || input.turn_id === state.turn_id,
        'Checkpoint turn ID does not match the current tracked turn');
    }
    const payload = prepare(context, {...input, turn_id: input.turn_id ?? state?.turn_id});
    if (state) {
      state.status = 'pending';
      saveTurn(context, state);
    }
    return payload;
  });
}

function complete(receipts) {
  return receipts.length > 0 && receipts.every((receipt) => receipt.ledger === 'applied'
    && receipt.index === 'applied' && receipt.errors.length === 0
    && ['applied', 'not-needed', 'superseded'].includes(receipt.podium)
    && ['applied', 'not-needed', 'superseded'].includes(receipt.library));
}

export function finishTurn(context, input) {
  requireValue(['Stop', 'PreCompact', 'StopFailure'].includes(input.hook_event_name), 'Unsupported hook event');
  return withSession(context, input.session_id, () => {
    const state = currentTurn(context, input.session_id);
    let result;
    let failure = null;
    try {
      result = flush(context, input.session_id);
    } catch (error) {
      failure = error.code ?? error.message;
    }
    // Existing installations can still flush before the first tracked prompt.
    if (!state) return {state: null, result, failure, block: false, receipts: []};
    const receipts = result?.checkpoints.filter((receipt) => receipt.turn_id === state.turn_id) ?? [];
    const incomplete = result?.checkpoints.some((receipt) => receipt.errors.length > 0);
    if (input.hook_event_name === 'StopFailure') state.status = 'interrupted';
    else if (failure || incomplete) state.status = 'write-failed';
    else if (complete(receipts)) state.status = 'saved';
    else state.status = 'missing';

    const block = input.hook_event_name === 'Stop' && state.status !== 'saved'
      && !state.repair_requested && input.stop_hook_active !== true;
    if (block) state.repair_requested = true;
    saveTurn(context, state);
    return {state, result, failure, block, receipts};
  });
}

export function memoryHealth(context, session) {
  if (!identifier(session)) return 'Memory untracked';
  const state = currentTurn(context, session);
  if (!state) return 'Memory untracked';
  const labels = {
    pending: 'pending',
    saved: 'saved',
    missing: 'checkpoint missing',
    'write-failed': 'write failed',
    interrupted: 'interrupted',
  };
  const gaps = state.previous_gaps ? `; ${state.previous_gaps} earlier gaps` : '';
  return `Memory ${labels[state.status]}${gaps}`;
}
