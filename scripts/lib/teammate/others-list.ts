/**
 * The Others' PRs list: the teammate PRs you have been asked to look at, kept as an append-only JSONL file beside the tab's cache (`<statusDir>/.now-others-list.jsonl`).
 * Only PRs on this list are read from GitHub (lib/teammate/others.ts), so the tab no longer queries every open teammate PR.
 *
 * A row is `add` (a PR joined, and by which route) or `drop` (it left, and why). The state is the fold: the latest row per PR key wins.
 * A drop remembers the PR's `updatedAt` and when it happened, so a later discovery re-adds the PR only if something happened since (`mayRejoin`):
 * a PR that is still review-requested on GitHub does not bounce back onto the list the moment it was dropped as stale. An explicit ask (a Slack post
 * newer than the drop, or you adding it by hand) always rejoins.
 *
 * What a row holds: the PR key, the route, a time, and for a Slack ask the channel and the author's display name. Never message text.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../status-page/seen.ts';
import { isPrKey } from './others-actions.ts';

/** A PR key whose owner is shaped like a GitHub login (never `.` or `..`): the key goes into a GraphQL query, so it is checked tighter than a plain key. */
export const isListKey = (k: unknown): k is string => isPrKey(k) && /^[A-Za-z0-9][A-Za-z0-9-]*\//.test(k);
/** GitHub treats owner and repo names case-insensitively, so a list key is lower case: the same PR named two ways is one entry. */
export const listKey = (k: string): string => k.toLowerCase();

export const OTHERS_LIST = '.now-others-list.jsonl';
export const listPath = (statusDir: string): string => join(statusDir, OTHERS_LIST);

/** How a PR joined: a Slack review ask, a GitHub review request, an @-mention of you, you adding it, a staging twin, a backmerge, a P0 or hotfix PR, or the migration seed. */
export const SOURCES = ['slack', 'review-request', 'mention', 'manual', 'twin', 'backmerge', 'hotfix', 'seed'] as const;
export type JoinSource = typeof SOURCES[number];
const isSource = (s: unknown): s is JoinSource => typeof s === 'string' && (SOURCES as readonly string[]).includes(s);

export interface ListEntry {
  key: string; source: JoinSource;
  /** When the ask was made (ms): the Slack post's time, else when it was added. This is the first sign of life the staleness clock counts. */
  at: number;
  /** A Slack ask's channel (the note's name) and the poster's display name; nothing else of the message is kept. */
  channel?: string; author?: string;
}
export interface DropRecord { ts: number; why: string; updatedAt?: string }
export interface ListState { active: Map<string, ListEntry>; dropped: Map<string, DropRecord>; rows: number }

type Row =
  | { op: 'add'; key: string; source: JoinSource; at: number; ts: number; channel?: string; author?: string }
  | { op: 'drop'; key: string; why: string; ts: number; updatedAt?: string };

const short = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function parseRow(line: string): Row | null {
  let r: unknown;
  try { r = JSON.parse(line); } catch { return null; }
  if (typeof r !== 'object' || r === null) return null;
  const x = r as Record<string, unknown>;
  if (!isListKey(x.key) || typeof x.ts !== 'number' || !Number.isFinite(x.ts)) return null;
  const key = listKey(x.key);
  if (x.op === 'drop') {
    const updatedAt = short(x.updatedAt, 40);
    return { op: 'drop', key, why: short(x.why, 120) ?? 'dropped', ts: x.ts, ...(updatedAt ? { updatedAt } : {}) };
  }
  if (x.op !== 'add' || !isSource(x.source) || typeof x.at !== 'number' || !Number.isFinite(x.at)) return null;
  const channel = short(x.channel, 80);
  const author = short(x.author, 80);
  return { op: 'add', key, source: x.source, at: x.at, ts: x.ts, ...(channel ? { channel } : {}), ...(author ? { author } : {}) };
}

/** The list as it stands. A missing or damaged file is an empty list; a row that does not parse is skipped. */
export function readList(file: string): ListState {
  const state: ListState = { active: new Map(), dropped: new Map(), rows: 0 };
  if (!existsSync(file)) return state;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return state; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = parseRow(line);
    if (!row) continue;
    state.rows += 1;
    if (row.op === 'add') {
      state.dropped.delete(row.key);
      if (!state.active.has(row.key)) state.active.set(row.key, { key: row.key, source: row.source, at: row.at, ...(row.channel ? { channel: row.channel } : {}), ...(row.author ? { author: row.author } : {}) });
    } else {
      state.active.delete(row.key);
      state.dropped.set(row.key, { ts: row.ts, why: row.why, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) });
    }
  }
  return state;
}

function append(file: string, row: Row): void { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(row)}\n`); }

/** Adds a PR. Idempotent: a PR already on the list writes nothing. Returns whether a row was written. Throws on a malformed key. */
export function addToList(file: string, e: Omit<ListEntry, 'at'> & { at?: number }, now: number = Date.now()): boolean {
  if (!isListKey(e.key)) throw new Error(`not a PR key (owner/repo#number): ${e.key}`);
  const key = listKey(e.key);
  if (readList(file).active.has(key)) return false;
  append(file, { op: 'add', key, source: e.source, at: e.at ?? now, ts: now, ...(e.channel ? { channel: e.channel } : {}), ...(e.author ? { author: e.author } : {}) });
  return true;
}

/** Drops a PR with a reason (and the `updatedAt` it was judged at). Idempotent: a PR not on the list writes nothing. */
export function dropFromList(file: string, rawKey: string, why: string, updatedAt?: string, now: number = Date.now()): boolean {
  if (!isListKey(rawKey)) throw new Error(`not a PR key (owner/repo#number): ${rawKey}`);
  const key = listKey(rawKey);
  if (!readList(file).active.has(key)) return false;
  append(file, { op: 'drop', key, why, ts: now, ...(updatedAt ? { updatedAt } : {}) });
  return true;
}

/** What a discovery saw of a PR: when someone asked (a Slack post's time) and the PR's `updatedAt` (a GitHub search result). */
export interface Evidence { askedAt?: number; updatedAt?: string }

/**
 * Whether a discovered PR should join the list. Not if it is on it already. A PR that was never dropped joins. A dropped one rejoins only on news:
 * an ask newer than the drop, or a GitHub `updatedAt` later than the one it was dropped at (a push, a comment, a review or a re-request moves it).
 */
export function mayRejoin(state: ListState, rawKey: string, ev: Evidence): boolean {
  const key = listKey(rawKey);
  if (state.active.has(key)) return false;
  const gone = state.dropped.get(key);
  if (!gone) return true;
  if (ev.askedAt !== undefined && ev.askedAt > gone.ts) return true;
  return ev.updatedAt !== undefined && gone.updatedAt !== undefined && Date.parse(ev.updatedAt) > Date.parse(gone.updatedAt);
}

const KEEP_DROPS_MS = 30 * 86_400_000;

/** Rewrites the file as its fold (active adds, and drops from the last 30 days) once it holds twice as many rows as keys, so it does not grow forever. Returns whether it rewrote. */
export function compactList(file: string, now: number = Date.now()): boolean {
  const s = readList(file);
  if (s.rows < 20 || s.rows <= 2 * (s.active.size + s.dropped.size)) return false;
  const rows: Row[] = [
    ...[...s.active.values()].map((e): Row => ({ op: 'add', key: e.key, source: e.source, at: e.at, ts: e.at, ...(e.channel ? { channel: e.channel } : {}), ...(e.author ? { author: e.author } : {}) })),
    ...[...s.dropped].filter(([, d]) => now - d.ts < KEEP_DROPS_MS).map(([key, d]): Row => ({ op: 'drop', key, why: d.why, ts: d.ts, ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}) })),
  ];
  writeAtomic(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return true;
}
