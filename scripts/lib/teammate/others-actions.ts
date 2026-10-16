/**
 * What the person does to a teammate's PR from the Others' PRs tab besides reviewing it: Ignore it, or ask for a review of a hands-off PR ("Review anyway").
 * Storage is an append-only JSONL file beside the draft queue (`<ledger root>/Projects/<project>/Journal/others-actions.jsonl`); the state is the fold of its rows.
 *
 * An ignore is pinned to the head commit it was made on: a push gives the PR a new head, so the ignore no longer applies and the PR comes back marked
 * "new commits since you ignored". An ignored PR is left out of the tab's lists, of REVIEW-WAIT (lib/teammate/wait.ts) and of the repost nudge's draft clock.
 * A review request names a head too; pr-watch reads it and raises one REVIEW-WAIT line for that PR even though its repo is hands off. Nothing here posts to GitHub.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { draftsPath } from '../drafts/queue.ts';

export type ActionRow =
  | { op: 'ignore'; key: string; head: string; ts: string }
  | { op: 'unignore'; key: string; ts: string }
  | { op: 'review-anyway'; key: string; head: string; ts: string };

const KEY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,8}$/;
const SHA = /^[0-9a-f]{40}$/;
export const isPrKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k);
export const isSha = (h: unknown): h is string => typeof h === 'string' && SHA.test(h);

/** The actions file beside the drafts file of the same project. */
export const actionsPath = (vault: string, project: string): string => join(dirname(draftsPath(vault, project)), 'others-actions.jsonl');

function readRows(file: string): ActionRow[] {
  if (!existsSync(file)) return [];
  const rows: ActionRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: unknown;
    try { r = JSON.parse(line); } catch { continue; }
    if (typeof r !== 'object' || r === null) continue;
    const x = r as Record<string, unknown>;
    if (!isPrKey(x.key) || typeof x.ts !== 'string') continue;
    if (x.op === 'unignore') rows.push({ op: 'unignore', key: x.key, ts: x.ts });
    else if ((x.op === 'ignore' || x.op === 'review-anyway') && isSha(x.head)) rows.push({ op: x.op, key: x.key, head: x.head, ts: x.ts });
  }
  return rows;
}

/** PR key -> the head it was ignored at. An unignore removes it; a later ignore puts it back. */
export function readIgnored(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of readRows(file)) { if (r.op === 'ignore') out.set(r.key, r.head); else if (r.op === 'unignore') out.delete(r.key); }
  return out;
}

/** PR key -> the head a review was requested at (the latest request wins). */
export function readRequests(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of readRows(file)) if (r.op === 'review-anyway') out.set(r.key, r.head);
  return out;
}

/** Both folds from one read of the file, so a poll sees one state of it. */
export function readActions(file: string): { ignored: Map<string, string>; requests: Map<string, string> } {
  const rows = readRows(file);
  const ignored = new Map<string, string>();
  const requests = new Map<string, string>();
  for (const r of rows) { if (r.op === 'ignore') ignored.set(r.key, r.head); else if (r.op === 'unignore') ignored.delete(r.key); else requests.set(r.key, r.head); }
  return { ignored, requests };
}

/** `ignored`: the ignore still holds (same head). `new-commits`: it was ignored, but the PR has a new head. `null`: not ignored. */
export function ignoreState(ignored: ReadonlyMap<string, string>, key: string, head: string | undefined): 'ignored' | 'new-commits' | null {
  const at = ignored.get(key);
  if (at === undefined) return null;
  return head && head !== at ? 'new-commits' : 'ignored';
}

/** True while the PR is ignored at its current head. A PR whose head is unknown stays ignored (the safe side for REVIEW-WAIT). */
export const isIgnored = (ignored: ReadonlyMap<string, string>, key: string, head: string | undefined): boolean => ignoreState(ignored, key, head) === 'ignored';

function append(file: string, row: ActionRow): void { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(row)}\n`); }
const stamp = (now?: () => Date): string => (now?.() ?? new Date()).toISOString();

/** Ignores the PR at this head. Idempotent: already ignored at this head writes nothing. Throws on a malformed key or head. */
export function ignorePr(file: string, key: string, head: string, now?: () => Date): boolean {
  if (!isPrKey(key) || !isSha(head)) throw new Error('ignore needs a PR key and a full head sha');
  if (readIgnored(file).get(key) === head) return false;
  append(file, { op: 'ignore', key, head, ts: stamp(now) });
  return true;
}

/** Stops ignoring the PR. Idempotent. */
export function unignorePr(file: string, key: string, now?: () => Date): boolean {
  if (!isPrKey(key)) throw new Error('unignore needs a PR key');
  if (!readIgnored(file).has(key)) return false;
  append(file, { op: 'unignore', key, ts: stamp(now) });
  return true;
}

/** Asks for a review of a hands-off PR at this head. Idempotent per head. */
export function requestReview(file: string, key: string, head: string, now?: () => Date): boolean {
  if (!isPrKey(key) || !isSha(head)) throw new Error('a review request needs a PR key and a full head sha');
  if (readRequests(file).get(key) === head) return false;
  append(file, { op: 'review-anyway', key, head, ts: stamp(now) });
  return true;
}
