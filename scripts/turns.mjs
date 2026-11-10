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
  keys(state, ['version', 'session_id', 'turn_id', 'started_at', 'status', 'repair_requested', 'previous_gaps', 'last_checkpoint_at'],
    ['version', 'session_id', 'turn_id', 'started_at', 'status', 'repair_requested', 'previous_gaps']);
  requireValue(state.version === 1 && state.session_id === session && identifier(state.turn_id)
    && typeof state.started_at === 'string' && Number.isFinite(Date.parse(state.started_at))
    && states.includes(state.status) && typeof state.repair_requested === 'boolean'
    && Number.isSafeInteger(state.previous_gaps) && state.previous_gaps >= 0, 'Invalid turn tracking state');
  requireValue(state.last_checkpoint_at === undefined || state.last_checkpoint_at === null
    || (typeof state.last_checkpoint_at === 'string' && Number.isFinite(Date.parse(state.last_checkpoint_at))),
  'Invalid last checkpoint timestamp');
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
      last_checkpoint_at: previous?.last_checkpoint_at ?? null,
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
    const wasSaved = state.status === 'saved';
    if (input.hook_event_name === 'StopFailure') state.status = 'interrupted';
    else if (failure || incomplete) state.status = 'write-failed';
    else if (complete(receipts)) state.status = 'saved';
    else state.status = 'missing';
    if (state.status === 'saved' && (!wasSaved || !state.last_checkpoint_at)) {
      state.last_checkpoint_at = new Date().toISOString();
    }

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
    missing: 'checkpoint missing',
    'write-failed': 'write failed',
    interrupted: 'interrupted',
  };
  const checkpoint = state.last_checkpoint_at
    ? `Muninn ${checkpointTime(state.last_checkpoint_at)}`
    : 'Muninn unknown';
  if (state.status === 'saved') return checkpoint;
  return `${state.last_checkpoint_at ? `${checkpoint}; ` : ''}Memory ${labels[state.status]}`;
}

function checkpointTime(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).map(({type, value}) => [type, value]));
  return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
}
