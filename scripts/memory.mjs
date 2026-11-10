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
let local = path.join(os.homedir(), '.config/the-maestro/settings.json');

function stdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(Buffer.byteLength(text) <= 1048576, 'Input exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid input JSON'); }
}

function checkpointInstructions(state, repair = false) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const cli = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))}`;
  const settings = `--settings ${quote(local)}`;
  if (repair) {
    return `Save THIS turn's missing or failed checkpoint within existing permissions. ` +
      `Run ${cli} prepare ${settings} with JSON on stdin ` +
      `{"session_id":"${state.session_id}","turn_id":"${state.turn_id}","topics":[],"events":[],"pages":[]}. ` +
      'Include safe outcomes/decisions and relevant Podium/Library patches; empty arrays are only for genuinely no-change turns. ' +
      `Schema and conflict recovery: ${quote(path.join(root, 'reference/persistence.md'))}. ` +
      `Then run ${cli} flush ${settings} ${quote(state.session_id)} and verify current-turn receipts and affected pages. ` +
      'Reuse prepared payloads on retry; reconcile conflicts without overwriting newer edits or stealing locks. ' +
      'Never read transcripts or store personal data or secrets.';
  }
  return `Maestro memory: session_id=${state.session_id}, turn_id=${state.turn_id}. ` +
    'Podium is the single source of truth for persistent current state; context notes, plans and handoffs link there instead of maintaining competing status files. ' +
    'Ledger stores history and rationale, Library reusable knowledge, and checkpoint records technical receipts. ' +
    'For every user question in chat, question forms or Podium, include context, concrete options and material tradeoffs, plus a recommendation and why. ' +
    'State unknowns; for factual clarification with no defensible recommendation, explain the information needed and why. ' +
    `Before finishing, prepare a safe checkpoint for THIS turn using ${cli} prepare ${settings} with JSON on stdin ` +
    `{"session_id":"${state.session_id}","turn_id":"${state.turn_id}","topics":[],"events":[],"pages":[]}, ` +
    'using relevant safe decisions, outcomes, rationale, evidence and next actions. ' +
    `When needed, read ${quote(path.join(root, 'reference/persistence.md'))} for the schema and patch rules; reuse existing topics via search. ` +
    'Empty arrays are only for genuinely no-change turns. ' +
    'For changes to active PRs, blockers, next actions or open questions, read Podium/README.md and the relevant stream page, ' +
    'then include revision-checked Podium patches in pages; ledger events alone do not update Podium. ' +
    'Refresh edited-page updated dates and affected landing/stream summaries, status, blockers and next actions together; preserve rank and unrelated edits. Keep pass, partial and not-run distinct. Do not ask permission for routine coupled corrections backed by verified evidence. ' +
    'Keep only PRs in the work currently in progress, not every open PR. Use verified PR links, observed review/CI and checked times; mark unavailable evidence explicitly. ' +
    'Show questions with their ledger event IDs; record the resolving decision before removing them. ' +
    'Preserve user priorities, unrelated edits and newer updates from other sessions. Include relevant verified reusable library patches. ' +
    `Then run ${cli} flush ${settings} ${quote(state.session_id)} and verify each receipt before finishing. ` +
    'For changed coordination, read back the affected Podium sections to verify PRs and questions; a saved ledger receipt does not prove board freshness. ' +
    'Do this automatically; routine memory updates need no user reminder. ' +
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
    console.log(JSON.stringify({decision: 'block', reason: `${notice} ${failure ? `${failure} ` : ''}${checkpointInstructions(state, true)} ` +
      'One automatic repair attempt only; unresolved gaps remain visible without looping.'}));
  } else {
    console.log(`${notice} Only prepared deltas are covered; complete turn capture is NOT verified.`);
    if (failure || incomplete || !state || state.status !== 'saved') process.exitCode = 1;
  }
  if (failure) console.error(`Memory flush failed: ${failure}`);
  if (!block && (!state || state.status !== 'saved')) {
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
