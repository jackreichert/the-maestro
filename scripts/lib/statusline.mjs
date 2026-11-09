import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJournal} from '../ledger.mjs';
import {readText, scopedPath} from '../storage.mjs';

export function summarizePullRequests(pullRequests) {
  if (!Array.isArray(pullRequests)) throw new Error('Expected pull request array');
  const summary = {drafts: 0, changesRequested: 0, approvedMergeable: 0};
  for (const pr of pullRequests) {
    if (typeof pr.isDraft !== 'boolean') throw new Error('Invalid pull request status');
    if (pr.isDraft) summary.drafts += 1;
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') summary.changesRequested += 1;
    else if (pr.reviewDecision === 'APPROVED' && pr.mergeStateStatus === 'CLEAN') summary.approvedMergeable += 1;
  }
  return summary;
}

export function countOpenQuestions(rows) {
  if (!Array.isArray(rows)) throw new Error('Expected journal rows');
  const events = rows.flatMap((row) => row.payload.events);
  const resolved = new Set(events.flatMap((event) => event.resolves ?? []));
  return events.filter((event) => event.kind === 'question' && !resolved.has(event.id)).length;
}

export function openQuestionCount(ledgerRoot) {
  return countOpenQuestions(readJournal(ledgerRoot));
}

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
  const repo = input?.workspace?.repo;
  const providedName = repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : null;
  let validRepo = typeof providedName === 'string' && /^[\w.-]+\/[\w.-]+$/.test(providedName)
    ? providedName : null;
  let repoError = null;
  if (!validRepo) {
    const repository = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      {cwd, encoding: 'utf8', timeout: 1000, maxBuffer: 1048576});
    if (repository.error || repository.status !== 0) {
      repoError = repository.error?.code ?? `gh repo view exited ${repository.status}`;
    } else {
      const name = repository.stdout.trim();
      if (/^[\w.-]+\/[\w.-]+$/.test(name)) validRepo = name;
      else repoError = 'invalid gh repository response';
    }
  }
  const workspaceSearch = validRepo
    ? `workspace: search(type: ISSUE, query: "is:pr is:open author:@me repo:${validRepo}", first: 100) {
        issueCount
        nodes {
          ... on PullRequest { isDraft reviewDecision mergeStateStatus }
        }
      }`
    : '';
  const query = `query {
    allOpen: search(type: ISSUE, query: "is:pr is:open author:@me", first: 1) { issueCount }
    ${workspaceSearch}
  }`;
  const result = run('gh', ['api', 'graphql', '-f', `query=${query}`],
    {cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 1048576});
  if (result.error || result.status !== 0) {
    const error = result.error?.code ?? `gh exited ${result.status}`;
    return {sessionPullRequests: null, allOpenCount: null, sessionError: error, allOpenError: error};
  }
  try {
    const data = JSON.parse(result.stdout)?.data;
    const allOpenCount = data?.allOpen?.issueCount;
    if (!Number.isInteger(allOpenCount) || allOpenCount < 0) {
      return {
        sessionPullRequests: null,
        allOpenCount: null,
        sessionError: repoError ?? 'invalid gh response',
        allOpenError: 'invalid gh response',
      };
    }

    if (!validRepo) {
      return {
        sessionPullRequests: null,
        allOpenCount,
        sessionError: repoError ?? 'current repository unavailable',
        allOpenError: null,
      };
    }
    const workspace = data?.workspace;
    const pullRequests = workspace?.nodes;
    if (!Array.isArray(pullRequests) || !Number.isInteger(workspace.issueCount) ||
        workspace.issueCount !== pullRequests.length) {
      return {
        sessionPullRequests: null,
        allOpenCount,
        sessionError: repoError ?? 'invalid or incomplete gh response',
        allOpenError: null,
      };
    }
    summarizePullRequests(pullRequests);
    return {sessionPullRequests: pullRequests, allOpenCount, sessionError: repoError, allOpenError: null};
  } catch {
    return {
      sessionPullRequests: null,
      allOpenCount: null,
      sessionError: repoError ?? 'invalid gh response',
      allOpenError: 'invalid gh response',
    };
  }
}

function prText(pullRequests) {
  if (pullRequests === null) return 'PRs here unavailable';
  const summary = summarizePullRequests(pullRequests);
  const parts = [
    summary.drafts && `${summary.drafts} draft`,
    summary.changesRequested && `${summary.changesRequested} changes requested`,
    summary.approvedMergeable && `${summary.approvedMergeable} approved/mergeable`,
  ].filter(Boolean);
  return parts.length ? `PRs here ${parts.join(', ')}` : 'PRs here 0 needing action';
}

function allOpenText(count) {
  return Number.isInteger(count) && count >= 0 ? `My open PRs ${count}` : 'My open PRs unavailable';
}

function contextText(value) {
  return Number.isFinite(value) && value >= 0 ? `Context ${Math.round(value)}%` : 'Context unavailable';
}

function costText(value) {
  return Number.isFinite(value) && value >= 0 ? `Session $${value.toFixed(2)} est.` : 'Session cost unavailable';
}

export function renderStatusLine({input, sessionPullRequests, allOpenCount, decisions, podiumUrl}) {
  const podium = podiumUrl
    ? `\u001b]8;;${podiumUrl}\u001b\\Podium\u001b]8;;\u001b\\`
    : 'Podium unavailable';
  const decisionText = Number.isInteger(decisions) && decisions >= 0
    ? `Decisions ${decisions}` : 'Decisions unavailable';
  return [
    'Maestro',
    prText(sessionPullRequests),
    allOpenText(allOpenCount),
    costText(input?.cost?.total_cost_usd),
    contextText(input?.context_window?.used_percentage),
    decisionText,
    podium,
  ].join(' | ');
}
