/**
 * The tracker snapshot, `<status dir>/tracker-items.json`: the issues assigned to the user in an outside tracker, as last fetched.
 * Nothing here talks to the tracker. A runner fetches the issues with whatever client it is authorised for (a playbook says how)
 * and pipes the result to `journal.ts tracker-import`, which normalises, validates, scans and writes it here.
 *
 * Accepted input: `{ items: [...] }` in this file's own shape, or a search result `{ issues: [...] }` (or a bare array) whose
 * issues carry their fields either at the top level or under `fields`, with `summary` or `title`, and `status` / `priority` as a
 * string or `{ name }`. A `description` is read only to set `doneLooksLike` and is never stored. Titles are clipped to one line;
 * a title the secret and PHI scanner flags (scanned whole, before the clip) is replaced by a placeholder naming the rule, so nothing it flags reaches the disk.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeFindings, scanFields } from '../secret-scan.ts';
import { writeAtomic } from '../status-page/seen.ts';
import type { TrackerItem, TrackerSnapshot } from './rank.ts';

export const TRACKER_FILE = 'tracker-items.json';
export const MAX_ITEMS = 500;
export const TITLE_MAX = 200;
const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const LABEL_MAX = 60;
const LABELS_MAX = 20;
const SHORT_MAX = 40;
const URL_MAX = 300;
const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneLine = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** A string, or the `name` of an object (`{ name: 'High' }`), or ''. */
const nameOf = (v: unknown): string => (typeof v === 'string' ? v : isObj(v) && typeof v.name === 'string' ? v.name : '');
const date = (v: unknown): string | undefined => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined);

export interface Imported { snapshot: TrackerSnapshot; withheld: string[]; skipped: string[] }

/** The issues of an accepted input, or a reason it is not one. */
function issuesOf(raw: unknown): unknown[] | string {
  if (Array.isArray(raw)) return raw;
  if (isObj(raw) && Array.isArray(raw.items)) return raw.items;
  if (isObj(raw) && Array.isArray(raw.issues)) return raw.issues;
  return 'expected an array of issues, { items: [...] } or { issues: [...] }';
}

/** One issue in the snapshot's shape, or a reason to skip it. */
function normalise(v: unknown, withheld: string[]): TrackerItem | string {
  if (!isObj(v)) return 'not an object';
  const f = isObj(v.fields) ? { ...v, ...v.fields } : v;
  const key = typeof f.key === 'string' ? f.key.trim() : '';
  if (!KEY.test(key)) return `key ${JSON.stringify(oneLine(String(f.key ?? ''), 30))} is not a tracker key`;
  const rawTitle = typeof f.summary === 'string' ? f.summary : typeof f.title === 'string' ? f.title : '';
  let title = oneLine(rawTitle, TITLE_MAX) || key;
  const findings = scanFields({ title: rawTitle });
  if (findings.length) { withheld.push(key); title = `(title withheld: ${describeFindings(findings).join('; ').replace(/\s+/g, ' ').slice(0, 80)})`; }
  const labels = (Array.isArray(f.labels) ? f.labels : []).filter((l): l is string => typeof l === 'string').map((l) => oneLine(l, LABEL_MAX)).filter(Boolean).slice(0, LABELS_MAX);
  const url = typeof f.url === 'string' && /^https:\/\/\S+$/.test(f.url) && f.url.length <= URL_MAX ? f.url : undefined;
  const done = typeof f.doneLooksLike === 'boolean' ? f.doneLooksLike : typeof f.description === 'string' ? /what done looks like/i.test(f.description) : undefined;
  return {
    key, title, status: oneLine(nameOf(f.status), SHORT_MAX) || 'open', priority: oneLine(nameOf(f.priority), SHORT_MAX), labels,
    ...(date(f.created) ? { created: date(f.created) } : {}), ...(date(f.updated) ? { updated: date(f.updated) } : {}),
    ...(url ? { url } : {}), ...(done === undefined ? {} : { doneLooksLike: done }),
  };
}

/** Normalises a fetched result. Throws on a shape that is not a list of issues or one over the item cap; skips (and names) single bad issues. */
export function importTracker(raw: unknown, opts: { source: string; fetchedAt: Date }): Imported {
  if (!SOURCE.test(opts.source)) throw new Error(`--source must be a short lowercase name such as "jira", got ${JSON.stringify(opts.source)}`);
  const issues = issuesOf(raw);
  if (typeof issues === 'string') throw new Error(`tracker-import: ${issues}`);
  if (issues.length > MAX_ITEMS) throw new Error(`tracker-import: ${issues.length} issues is over the cap of ${MAX_ITEMS}; narrow the query`);
  const withheld: string[] = [];
  const skipped: string[] = [];
  const items = new Map<string, TrackerItem>();
  issues.forEach((v, i) => {
    const r = normalise(v, withheld);
    if (typeof r === 'string') skipped.push(`#${i + 1}: ${r}`);
    else items.set(r.key, r);
  });
  return { snapshot: { fetchedAt: opts.fetchedAt.toISOString(), source: opts.source, items: [...items.values()] }, withheld, skipped };
}

export function writeTracker(statusDir: string, snapshot: TrackerSnapshot): string {
  mkdirSync(statusDir, { recursive: true });
  const path = join(statusDir, TRACKER_FILE);
  writeAtomic(path, `${JSON.stringify(snapshot, null, 1)}\n`);
  return path;
}

const isItem = (v: unknown): v is TrackerItem => isObj(v) && typeof v.key === 'string' && KEY.test(v.key) && typeof v.title === 'string' && typeof v.status === 'string' && typeof v.priority === 'string' && Array.isArray(v.labels) && v.labels.every((l) => typeof l === 'string');

/** The stored snapshot, or null when there is none or it is not shaped like one (a hand-damaged file must not break a caller). */
export function readTracker(statusDir: string): TrackerSnapshot | null {
  const path = join(statusDir, TRACKER_FILE);
  if (!existsSync(path) || statSync(path).size > 4 * 1024 * 1024) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObj(v) || typeof v.fetchedAt !== 'string' || !Number.isFinite(Date.parse(v.fetchedAt)) || typeof v.source !== 'string' || !Array.isArray(v.items) || !v.items.every(isItem)) return null;
    return { fetchedAt: v.fetchedAt, source: v.source, items: v.items };
  } catch { return null; }
}
