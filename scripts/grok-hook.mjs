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
const notStarted = 'Memory turn did not start.';

function stdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(Buffer.byteLength(text) <= 1048576, 'Input exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid input JSON'); }
}

function main() {
  const settingsPosition = args.indexOf('--settings');
  if (settingsPosition !== -1) {
    requireValue(typeof args[settingsPosition + 1] === 'string', 'Missing settings path');
    local = args[settingsPosition + 1];
    args.splice(settingsPosition, 2);
  }
  requireValue(args.length === 0, 'grok-hook accepts JSON on stdin only');
  const input = stdinJson();
  if (input?.hookEventName === 'user_prompt_submit') {
    if (!identifier(input.sessionId)) {
      console.error(notStarted);
      process.exitCode = 1;
      return;
    }
    startTurn(loadSettings(path.join(root, 'settings.json'), local), input.sessionId);
    return;
  }
  if (input?.hookEventName !== 'pre_compact') {
    console.error('Unsupported hook event');
    process.exitCode = 1;
    return;
  }
  if (!identifier(input.sessionId)) {
    console.error(unsaved);
    process.exitCode = 1;
    return;
  }
  const context = loadSettings(path.join(root, 'settings.json'), local);
  const {state, result, failure} = finishTurn(context, {
    hook_event_name: 'PreCompact',
    session_id: input.sessionId,
  });
  const incomplete = result?.checkpoints.some((item) => item.errors.length) ?? false;
  if (!(failure || incomplete || !state || state.status !== 'saved')) return;
  console.error(failure ? `Memory flush failed: ${failure}` : unsaved);
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`Memory operation failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
