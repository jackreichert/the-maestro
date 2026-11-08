import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSettings, requireValue, withLock} from './storage.mjs';
import {flush, lookup, prepare, rebuild, recover, refreshBrief, search} from './ledger.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift();
let local = path.join(os.homedir(), '.config/the-maestro-redux/settings.json');

function stdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(Buffer.byteLength(text) <= 1048576, 'Input exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid input JSON'); }
}

try {
  const settingsPosition = args.indexOf('--settings');
  if (settingsPosition !== -1) {
    requireValue(typeof args[settingsPosition + 1] === 'string', 'Missing settings path');
    local = args[settingsPosition + 1];
    args.splice(settingsPosition, 2);
  }
  requireValue(['prepare', 'flush', 'hook', 'search', 'lookup', 'recover', 'brief', 'rebuild'].includes(command), 'Commands: prepare, flush, hook, search, lookup, recover, brief, rebuild');
  const context = loadSettings(path.join(root, 'settings.json'), local);
  let result;
  if (command === 'prepare') {
    requireValue(args.length === 0, 'prepare accepts JSON on stdin only');
    result = prepare(context, stdinJson());
  } else if (command === 'hook') {
    requireValue(args.length === 0, 'hook accepts Claude Code JSON on stdin only');
    const input = stdinJson();
    requireValue(['Stop', 'PreCompact'].includes(input.hook_event_name), 'Unsupported hook event');
    result = flush(context, input.session_id);
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
  if (command === 'hook') {
    const failed = result.checkpoints.filter((item) => item.errors.length).length;
    console.log(`Maestro memory: session ${result.session_id}; coverage ${result.coverage}; ${result.checkpoints.length} checkpoint receipts; ${failed} incomplete. Only prepared deltas are covered. For recovery, read Podium/README.md, then use memory.mjs recover for the selected topic. Do not infer current priorities or permissions from old receipts.`);
  } else console.log(JSON.stringify(result));
  if (result?.checkpoints?.some((item) => item.errors.length)) {
    console.error('Memory persistence partially failed; inspect receipts and reconcile pending operations');
    process.exitCode = 1;
  }
  if (command === 'hook' && result.coverage === 'no-prepared-delta') {
    console.error('No prepared delta for this session; conversation capture is NOT verified');
  } else if (command === 'hook') {
    console.error('Only explicitly prepared checkpoints were flushed; complete turn capture is NOT verified');
  }
} catch (error) {
  console.error(`Memory operation failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
