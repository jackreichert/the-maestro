/**
 * pr-merged: one PR, reported when it merges. Target `owner/repo#123` (or the PR URL).
 * State { state: OPEN|MERGED|CLOSED, repo, number, title, head, base, keys[] }. Done when the PR is merged or closed.
 * Actionable: the merge. The digest line names the repo and PR and lists the tracker keys found in the title and branch
 * (pattern: `tracker_key_pattern`, generic by default), because the orchestrator's merge checklist (reference/ledger.md,
 * "On every merge") starts from them. A PR closed without merging is informational. The title is untrusted data.
 */
import { TRACKER_KEY_PATTERN } from '../local-config.ts';
import { markPrsDirty } from '../lib/status-page/dirty.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface PrMergedState { state: string; repo: string; number: string; title: string; head: string; base: string; keys: string[] }

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = 240;
export const network = true;
const TARGET = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/;
const MAX_TITLE = 100;

export const parseTarget = (target: unknown): { repo: string; number: string } => {
  const m = String(target).match(TARGET);
  if (!m) throw new Error(`pr-merged target must look like owner/repo#123, got "${target}"`);
  return { repo: m[1] as string, number: m[2] as string };
};

/** Distinct tracker keys in the given texts, in order of appearance. */
export function extractKeys(texts: unknown[], pattern: string = TRACKER_KEY_PATTERN): string[] {
  const re = new RegExp(pattern, 'g');
  return [...new Set(texts.flatMap((t) => String(t || '').match(re) || []))];
}

export function check(target: string, ctx: Pick<CheckContext, 'run'>): PrMergedState {
  const { repo, number } = parseTarget(target);
  const r = ctx.run('gh', ['pr', 'view', number, '--repo', repo, '--json', 'state,title,headRefName,baseRefName']);
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`gh pr view failed: ${(r.stderr || '').split('\n')[0]}`);
  const pr = JSON.parse(r.stdout) as { state: string; title?: string; headRefName: string; baseRefName: string };
  return { state: pr.state, repo, number, title: String(pr.title || ''), head: pr.headRefName, base: pr.baseRefName, keys: extractKeys([pr.title, pr.headRefName]) };
}

const oneLine = (t: unknown, max = MAX_TITLE): string => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The events for a state change. Any event also marks the status page's PR data dirty (see lib/status-page/dirty.ts). */
export function diff(prev: PrMergedState | null, next: PrMergedState): WatchEvent[] {
  const events = changes(prev, next);
  if (events.length) markPrsDirty();
  return events;
}

function changes(prev: PrMergedState | null, next: PrMergedState): WatchEvent[] {
  if (next.state === prev?.state) return [];
  const pr = `${next.repo}#${next.number}`;
  if (next.state === 'MERGED') {
    // Keys come first and everything after is clipped, so the digest's own length cap can never cut the keys off; the title is JSON-quoted so a quote in it cannot fake a field.
    return [{ summary: `MERGED ${pr}; tracker keys: ${next.keys.join(', ') || 'none'}; base ${oneLine(next.base, 60)}; branch ${oneLine(next.head, 80)}; title ${JSON.stringify(oneLine(next.title))}` }];
  }
  if (next.state === 'CLOSED') return [{ summary: `CLOSED without merging ${pr}`, actionable: false }];
  return [];
}

export const done = (state: PrMergedState): boolean => state.state === 'MERGED' || state.state === 'CLOSED';
