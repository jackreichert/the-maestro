import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {identifier} from './schema.mjs';
import {loadSettings, requireValue} from './storage.mjs';
import {finishTurn, startTurn} from './turns.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let local = path.join(os.homedir(), '.config', 'the-maestro', 'settings.json');
const unsaved = 'Memory flush did not save this turn.';

function stdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(Buffer.byteLength(text) <= 1048576, 'Input exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid input JSON'); }
}

function emit(body, code = 0) {
  console.log(JSON.stringify(body));
  process.exitCode = code;
}

function main() {
  const settingsPosition = args.indexOf('--settings');
  if (settingsPosition !== -1) {
    requireValue(typeof args[settingsPosition + 1] === 'string', 'Missing settings path');
    local = args[settingsPosition + 1];
    args.splice(settingsPosition, 2);
  }
  requireValue(args.length === 0, 'cursor-hook accepts JSON on stdin only');
  const input = stdinJson();
  if (input?.hook_event_name === 'beforeSubmitPrompt') {
    if (identifier(input.conversation_id)) startTurn(loadSettings(path.join(root, 'settings.json'), local), input.conversation_id);
    emit({continue: true});
    return;
  }
  if (input?.hook_event_name !== 'preCompact') {
    console.error('Unsupported hook event');
    process.exitCode = 1;
    return;
  }
  if (!identifier(input.conversation_id)) {
    emit({user_message: unsaved}, 1);
    return;
  }
  const context = loadSettings(path.join(root, 'settings.json'), local);
  const {state, result, failure} = finishTurn(context, {
    hook_event_name: 'PreCompact',
    session_id: input.conversation_id,
  });
  const incomplete = result?.checkpoints.some((item) => item.errors.length) ?? false;
  if (failure) console.error(`Memory flush failed: ${failure}`);
  if (failure || incomplete || !state || state.status !== 'saved') emit({user_message: unsaved}, 1);
  else emit({});
}

try {
  main();
} catch (error) {
  console.error(`Memory operation failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
