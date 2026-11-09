import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadStatuslineSettings, requireValue} from './storage.mjs';
import {fetchPullRequests, openQuestionCount, podiumLink, renderStatusLine} from './lib/statusline.mjs';
import {memoryHealth} from './turns.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let local = path.join(os.homedir(), '.config/the-maestro-redux/settings.json');

function statuslineInput() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(Buffer.byteLength(text) <= 1048576, 'Input exceeds 1 MiB');
  try { return JSON.parse(text); } catch { throw new Error('Invalid Claude Code status-line JSON'); }
}

try {
  const settingsPosition = args.indexOf('--settings');
  if (settingsPosition !== -1) {
    requireValue(typeof args[settingsPosition + 1] === 'string', 'Missing settings path');
    local = args[settingsPosition + 1];
    args.splice(settingsPosition, 2);
  }
  requireValue(args.length === 0, 'Usage: statusline.mjs [--settings /absolute/settings.json]');

  const input = statuslineInput();
  const prs = fetchPullRequests(input);
  let context = null;
  try {
    context = loadStatuslineSettings(path.join(root, '..', 'settings.json'), local);
  } catch (error) {
    console.error(`Redux settings unavailable: ${error.code ?? error.message}`);
  }
  let decisions = null;
  if (context?.ledger) {
    try {
      decisions = openQuestionCount(context.ledger);
    } catch (error) {
      console.error(`Decision count unavailable: ${error.code ?? error.message}`);
    }
  }
  let podiumUrl = null;
  if (context?.vault) {
    try {
      podiumUrl = podiumLink(context.vault, context.settings.paths.container_root);
    } catch (error) {
      console.error(`Podium link unavailable: ${error.code ?? error.message}`);
    }
  }

  let memory = 'Memory unavailable';
  if (context?.ledger) {
    try {
      memory = memoryHealth(context, input?.session_id);
    } catch (error) {
      console.error(`Memory health unavailable: ${error.code ?? error.message}`);
    }
  }
  console.log(renderStatusLine({
    input,
    sessionPullRequests: prs.sessionPullRequests,
    allOpenCount: prs.allOpenCount,
    decisions,
    podiumUrl,
    memory,
  }));
  if (prs.sessionError) console.error(`Session-repo PR status unavailable: ${prs.sessionError}`);
  if (prs.allOpenError) console.error(`Open-PR count unavailable: ${prs.allOpenError}`);
} catch (error) {
  console.error(`Maestro status line unavailable: ${error.code ?? error.message}`);
  console.log('Maestro status line unavailable');
  process.exitCode = 1;
}
