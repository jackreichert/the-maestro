import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readText, scopedPath} from '../storage.mjs';
export {openQuestionCount} from '../ledger.mjs';

export function podiumLink(vaultRoot, containerRoot = null) {
  if (!vaultRoot) return null;
  const candidates = ['Podium/README.md'];
  const container = containerRoot ? path.basename(containerRoot) : null;
  if (container && /^[\w.-]+$/.test(container) && container !== '.' && container !== '..') {
    candidates.push(`Projects/${container}/Status/The-Podium.md`);
  }
  for (const relative of candidates) {
    const file = scopedPath(vaultRoot, relative);
    if (readText(vaultRoot, relative) !== null) return pathToFileURL(file).href;
  }
  return null;
}

export function fetchPullRequests(input, run = spawnSync) {
  const requestedCwd = input?.workspace?.current_dir ?? input?.cwd;
  const cwd = typeof requestedCwd === 'string' && path.isAbsolute(requestedCwd) ? requestedCwd : process.cwd();
  const query = `query {
    viewer {
      pullRequests(states: OPEN) { totalCount }
    }
  }`;
  const result = run('gh', ['api', 'graphql', '-f', `query=${query}`],
    {cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576});
  if (result.error || result.status !== 0) {
    const error = result.error?.code ?? `gh exited ${result.status}`;
    return {allOpenCount: null, error};
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    return {allOpenCount: null, error: 'invalid gh response'};
  }
  const allOpenCount = response?.data?.viewer?.pullRequests?.totalCount;
  if (response?.errors?.length || !Number.isInteger(allOpenCount) || allOpenCount < 0) {
    return {allOpenCount: null, error: 'invalid gh response'};
  }
  return {allOpenCount, error: null};
}

function prText(count) {
  return Number.isInteger(count) && count >= 0 ? `Open PRs ${count}` : 'Open PRs unavailable';
}

function contextText(value) {
  return Number.isFinite(value) && value >= 0 ? `Context ${Math.round(value)}%` : 'Context unavailable';
}

function costText(value) {
  return Number.isFinite(value) && value >= 0 ? `Session $${value.toFixed(2)} est.` : 'Session cost unavailable';
}

export function renderStatusLine({input, allOpenCount, decisions, podiumUrl, memory = 'Memory unavailable'}) {
  const podium = podiumUrl
    ? `\u001b]8;;${podiumUrl}\u001b\\Podium\u001b]8;;\u001b\\`
    : 'Podium unavailable';
  const decisionText = Number.isInteger(decisions) && decisions >= 0
    ? `Decisions ${decisions}` : 'Decisions unavailable';
  return [
    '\u{1F3BC} Maestro',
    podium,
    prText(allOpenCount),
    costText(input?.cost?.total_cost_usd),
    contextText(input?.context_window?.used_percentage),
    decisionText,
    memory,
  ].join(' | ');
}
