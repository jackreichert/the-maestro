import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSettings, requireValue, withLock} from './storage.mjs';
import {flush, lookup, rebuild, recover, refreshBrief, search} from './ledger.mjs';
import {currentTurn, finishTurn, prepareTurn, startTurn} from './turns.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift();
let local = path.join(os.homedir(), '.config/the-maestro-redux/settings.json');

function stdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(Buffer.byteLength(text) <= 1048576, 'Input exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid input JSON'); }
}

function checkpointInstructions(state) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const cli = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))}`;
  const settings = `--settings ${quote(local)}`;
  return `Maestro memory: session_id=${state.session_id}, turn_id=${state.turn_id}. ` +
    `Before finishing, prepare a safe checkpoint for THIS turn using ${cli} prepare ${settings} with JSON on stdin ` +
    `{"session_id":"${state.session_id}","turn_id":"${state.turn_id}","topics":[],"events":[],"pages":[]}, ` +
    'replacing the arrays with relevant safe decisions, outcomes, rationale, evidence and next actions. ' +
    `When needed, read ${quote(path.join(root, 'reference/persistence.md'))} for the schema and patch rules; reuse existing topics via search. ` +
    'Empty arrays are only for a genuinely no-change turn, never to bypass saving substantive work. ' +
    'Include changed Podium coordination and verified reusable library patches only when relevant; preserve existing edits. ' +
    `Then run ${cli} flush ${settings} ${quote(state.session_id)} and verify each receipt before finishing. ` +
    'Do this automatically; do not ask the user to request routine memory updates. ' +
    'Never read transcripts or store raw prompts, personal data or secrets.';
}

function hook(input, context) {
  if (input.hook_event_name === 'UserPromptSubmit') {
    const state = startTurn(context, input.session_id);
    console.log(JSON.stringify({hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: checkpointInstructions(state) +
        (state.previous_gaps ? ` ${state.previous_gaps} earlier turns have unresolved coverage gaps; do not claim they were captured.` : ''),
    }}));
    return;
  }
  const {state, result, failure, block, receipts} = finishTurn(context, input);
  const incomplete = result?.checkpoints.filter((item) => item.errors.length).length ?? 0;
  const notice = state
    ? `Maestro memory: turn ${state.turn_id}; ${state.status}; ${receipts.length} current-turn receipts; ${incomplete} incomplete.`
    : `Maestro memory: session ${input.session_id}; untracked turn; ${result?.checkpoints.length ?? 0} historical checkpoint receipts; ${incomplete} incomplete.`;
  if (block) {
    console.log(JSON.stringify({decision: 'block', reason: `${notice} ${failure ?? ''} ${checkpointInstructions(state)} ` +
      'Old receipts do not cover this turn. Repair within existing permissions only; do not overwrite conflicts or steal locks. ' +
      'This guard allows one automatic repair attempt, then reports any unresolved gap without looping.'}));
  } else {
    console.log(`${notice} Only prepared deltas are covered; complete turn capture is NOT verified.`);
    if (failure || incomplete || !state || state.status !== 'saved') process.exitCode = 1;
  }
  if (failure) console.error(`Memory flush failed: ${failure}`);
  if (!state || state.status !== 'saved') {
    console.error('Memory coverage incomplete; inspect turn state and receipts. No conversation capture is inferred.');
  }
}

try {
  const settingsPosition = args.indexOf('--settings');
  if (settingsPosition !== -1) {
    requireValue(typeof args[settingsPosition + 1] === 'string', 'Missing settings path');
    local = args[settingsPosition + 1];
    args.splice(settingsPosition, 2);
  }
  requireValue(['prepare', 'flush', 'hook', 'current', 'search', 'lookup', 'recover', 'brief', 'rebuild'].includes(command), 'Commands: prepare, flush, hook, current, search, lookup, recover, brief, rebuild');
  const context = loadSettings(path.join(root, 'settings.json'), local);
  let result;
  if (command === 'prepare') {
    requireValue(args.length === 0, 'prepare accepts JSON on stdin only');
    result = prepareTurn(context, stdinJson());
  } else if (command === 'hook') {
    requireValue(args.length === 0, 'hook accepts Claude Code JSON on stdin only');
    const input = stdinJson();
    hook(input, context);
  } else if (command === 'current') {
    requireValue(args.length === 1, 'current requires a session ID');
    result = {turn: currentTurn(context, args[0])};
  } else if (command === 'flush') {
    requireValue(args.length === 1, 'flush requires a session ID');
    result = flush(context, args[0]);
  } else if (command === 'search') {
    requireValue(args.length === 1, 'search requires one phrase');
    result = search(context, args[0]);
  } else if (command === 'lookup') {
    requireValue(args.length === 1, 'lookup requires one event ID');
    result = lookup(context, args[0]);
  } else if (command === 'recover' || command === 'brief') {
    requireValue(args.length === 1, `${command} requires one topic ID`);
    result = command === 'recover' ? recover(context, args[0]) : refreshBrief(context, args[0]);
  } else {
    requireValue(args.length === 0, 'rebuild takes no positional arguments');
    result = withLock(context.ledger, () => rebuild(context));
    result = {index: 'rebuilt'};
  }
  if (command !== 'hook') console.log(JSON.stringify(result));
  if (result?.checkpoints?.some((item) => item.errors.length)) {
    console.error('Memory persistence partially failed; inspect receipts and reconcile pending operations');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Memory operation failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
