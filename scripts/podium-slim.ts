#!/usr/bin/env node
/**
 * The focused Podium (slim S13): one generated page with three lists and nothing else, built by this script with no model and no network.
 *
 *   Open questions  the open asks in the ledger, each with a recommendation, the stakes and a link
 *   Jira in flight  the user's tracker tickets that are not done, from <status dir>/tracker-items.json (never the live tracker)
 *   PRs in flight   the user's open PRs, from the newest stored board (prs-snapshot.ts: prs-current.json or prs-snapshot.json)
 *
 *   podium-slim.ts [--ledger <root>] [--project <name>] [--status-dir <dir>] [--out <file.md>] [--html <file.html>]
 *       Writes the markdown page (default <status dir>/Podium-Slim.md; MAESTRO_PODIUM_SLIM_OUT overrides) and, when asked, a static HTML copy
 *       (--html, or MAESTRO_PODIUM_SLIM_HTML). A page that has not changed is not rewritten. Prints the path, line count and elapsed time.
 *
 * The event loop (event-types/status-refresh.ts) calls `generate` on every check when `mode: slim`. The page ends with a marked, empty
 * placeholder section (SETTINGS_HOOK) where the settings model can render its own section later.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fold } from './lib/ledger-core.ts';
import type { LedgerItem } from './lib/ledger-core.ts';
import { isOpen } from './lib/ledger-core.ts';
import { openStore } from './lib/journal/store.ts';
import { parseLink } from './lib/journal/ask-template.ts';
import { readTracker } from './lib/whats-next/tracker.ts';
import type { TrackerSnapshot } from './lib/whats-next/rank.ts';
import { writeAtomic } from './lib/status-page/seen.ts';
import { CONTAINER_PROJECT, LEDGER_ROOT, TRACKER_KEY_PATTERN, TRACKER_URL_BASE, VAULT_ROOT, statusDirFor } from './local-config.ts';
import { freshestSnapshotPath, loadSnapshot } from './prs-snapshot.ts';
import type { Snapshot, SnapshotPr } from './prs-snapshot.ts';

export const PAGE_FILE = 'Podium-Slim.md';
export const SETTINGS_HOOK = '<!-- podium-slim:settings-section:start -->';
export const SETTINGS_HOOK_END = '<!-- podium-slim:settings-section:end -->';

export interface Ask { id: string; text: string; recommend?: string; blocked?: string; links?: string[] }
export interface PageInput { now: Date; keyPattern: string; trackerUrlBase: string; asks: Ask[]; tracker: TrackerSnapshot | null; prs: Snapshot | null }

const DONE = /^(done|closed|resolved|cancell?ed|won'?t do|rejected)$/i;

/** One line of text safe inside a markdown list item: no newline, heading, table or link syntax a snapshot could smuggle in. */
const cell = (s: unknown, max = 160): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').replace(/[|[\]`]/g, '').replace(/^[#>\-*+\s]+/, '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const httpsOnly = (u: string): string => (/^https:\/\/[^\s()<>]+$/.test(u) ? u : '');
const link = (label: string, url: string): string => (httpsOnly(url) ? `[${cell(label, 80)}](${url})` : cell(label, 80));

const etStamp = (iso: string | undefined): string => {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return 'unknown time';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
};

/** The page, as markdown. Pure: everything it shows is in `input`. */
export function buildPage(input: PageInput): string {
  return [
    '# Podium', '',
    ...questionLines(input.asks), '',
    ...jiraLines(input), '',
    ...prLines(input.prs), '',
    SETTINGS_HOOK, SETTINGS_HOOK_END, '',
  ].join('\n');
}

function questionLines(asks: Ask[]): string[] {
  const out = ['## Open questions', ''];
  if (!asks.length) return [...out, 'Nothing is waiting on you.'];
  for (const a of asks) {
    out.push(`- **${cell(a.id, 20)}** ${cell(a.text, 300)}`, `  - Recommend: ${cell(a.recommend, 300) || 'none given'}`);
    if (a.blocked) out.push(`  - Stakes: ${cell(a.blocked, 300)}`);
    const l = (a.links ?? []).map((e) => parseLink(e)).find((x) => x && httpsOnly(x.url));
    if (l) out.push(`  - Link: ${link(l.label, l.url)}`);
  }
  return out;
}

function jiraLines({ tracker, prs, keyPattern, trackerUrlBase }: PageInput): string[] {
  const out = ['## Jira in flight', ''];
  if (!tracker) return [...out, 'No tracker snapshot yet.'];
  const items = tracker.items.filter((i) => !DONE.test(i.status.trim()));
  const re = (() => { try { return new RegExp(keyPattern, 'g'); } catch { return null; } })();
  const prsByKey = new Map<string, SnapshotPr[]>();
  for (const p of prs?.prs ?? []) for (const k of new Set(re ? `${p.title} ${p.headRefName}`.match(re) ?? [] : [])) prsByKey.set(k, [...(prsByKey.get(k) ?? []), p]);
  if (!items.length) out.push('No tickets in flight.');
  for (const i of items) {
    const linked = (prsByKey.get(i.key) ?? []).map((p) => link(`${p.repo}#${p.number}`, p.url)).join(', ');
    const key = trackerUrlBase ? link(i.key, `${trackerUrlBase}${i.key}`) : cell(i.key, 30);
    out.push(`- ${key} ${cell(i.title, 120)} — ${cell(i.status, 40)} · ${linked || 'no PR'}`);
  }
  return [...out, '', `Tracker snapshot from ${etStamp(tracker.fetchedAt)}.`];
}

const CHECKS: Record<string, string> = { SUCCESS: 'checks passing', PENDING: 'checks pending', EXPECTED: 'checks pending', FAILURE: 'checks failing', ERROR: 'checks failing', NONE: 'no checks' };
const MERGEABLE: Record<string, string> = { MERGEABLE: 'mergeable', CONFLICTING: 'has conflicts' };
const REVIEW: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' };

function prLines(snap: Snapshot | null): string[] {
  const out = ['## PRs in flight', ''];
  if (!snap) return [...out, 'No PR snapshot yet.'];
  if (!snap.prs.length) out.push('No open PRs.');
  for (const p of snap.prs) {
    const open = (p.threads ?? []).filter((t) => !t.isResolved && !t.isOutdated).length;
    out.push(`- ${link(`${p.repo}#${p.number}`, p.url)} ${cell(p.title, 120)} — ${[
      p.isDraft ? 'draft' : 'ready',
      CHECKS[p.ci ?? 'NONE'] ?? 'no checks',
      `${open} open thread${open === 1 ? '' : 's'}${p.threadsComplete === false ? ' (partial)' : ''}`,
      p.mergeable && MERGEABLE[p.mergeable] ? MERGEABLE[p.mergeable] : 'mergeable unknown',
      REVIEW[p.reviewDecision] ?? 'no review yet',
    ].join(' · ')}`);
  }
  return [...out, '', `PR snapshot from ${etStamp(snap.takenAt)}.`];
}

/** A static HTML copy of a page `buildPage` made: headings, list items, bold and links only. */
export function toHtml(md: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s: string): string => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https:\/\/[^\s()]+)\)/g, '<a href="$2">$1</a>');
  const body: string[] = [];
  let depth = 0;
  const closeTo = (d: number): void => { while (depth > d) { body.push('</ul>'); depth -= 1; } };
  for (const line of md.split('\n')) {
    const item = /^( *)- (.*)$/.exec(line);
    if (item) {
      const want = (item[1] ?? '').length >= 2 ? 2 : 1;
      closeTo(want);
      while (depth < want) { body.push('<ul>'); depth += 1; }
      body.push(`<li>${inline(item[2] ?? '')}</li>`);
      continue;
    }
    closeTo(0);
    const h = /^(#{1,2}) (.*)$/.exec(line);
    if (h) body.push(`<h${(h[1] ?? '').length}>${inline(h[2] ?? '')}</h${(h[1] ?? '').length}>`);
    else if (line.startsWith('<!--')) body.push(line);
    else if (line.trim()) body.push(`<p>${inline(line)}</p>`);
  }
  closeTo(0);
  return `<!doctype html>\n<meta charset="utf-8">\n<title>Podium</title>\n<body>\n${body.join('\n')}\n</body>\n`;
}

export interface GenerateOptions { ledger: string; project: string; statusDir: string; out: string; html: string; now: Date; keyPattern: string; trackerUrlBase: string }
export interface GenerateResult { lines: number; wrote: boolean; out: string }

/** Open asks the user owes an answer to: questions and pending decisions, not run-this asks, not closed. */
function openAsks(ledger: string, project: string): Ask[] {
  const store = openStore({ vault: ledger, project, dryRun: true, warn: () => undefined });
  if (!existsSync(store.ledgerPath)) return [];
  const { items, hidden } = fold(store.readLedger(), store.loadRegistry());
  return items
    .filter((i: LedgerItem) => !hidden.has(i.id ?? '') && isOpen(i) && (i.kind === 'question' || i.kind === 'decision') && !i.paste)
    .map((i: LedgerItem) => {
      const r = i as LedgerItem & { recommend?: unknown; blocked?: unknown; links?: unknown };
      return {
        id: i.id ?? '', text: String(i.text ?? ''), recommend: typeof r.recommend === 'string' ? r.recommend : undefined,
        blocked: typeof r.blocked === 'string' ? r.blocked : undefined, links: Array.isArray(r.links) ? r.links.filter((l): l is string => typeof l === 'string') : undefined,
      };
    });
}

const orNull = <T>(read: () => T | null): T | null => { try { return read(); } catch { return null; } };

/** Reads the three stores, renders the page and writes it (and the HTML copy) when it changed. Local reads only. */
export function generate(o: GenerateOptions): GenerateResult {
  const page = buildPage({
    now: o.now, keyPattern: o.keyPattern, trackerUrlBase: o.trackerUrlBase,
    asks: orNull(() => openAsks(o.ledger, o.project)) ?? [],
    tracker: orNull(() => readTracker(o.statusDir)),
    prs: orNull(() => loadSnapshot(freshestSnapshotPath(o.ledger))),
  });
  const wrote = writeIfChanged(o.out, page);
  if (o.html) writeIfChanged(o.html, toHtml(page));
  return { lines: page.split('\n').length - 1, wrote, out: o.out };
}

function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, text);
  return true;
}

/** The options the loop and the CLI share: configured roots, default paths, the environment's output overrides. */
export function defaultOptions(over: Partial<GenerateOptions> = {}): GenerateOptions {
  const project = over.project ?? CONTAINER_PROJECT;
  const statusDir = over.statusDir ?? statusDirFor(project);
  return {
    ledger: LEDGER_ROOT || VAULT_ROOT, project, statusDir, out: process.env.MAESTRO_PODIUM_SLIM_OUT || join(statusDir, PAGE_FILE),
    html: process.env.MAESTRO_PODIUM_SLIM_HTML ?? '', now: new Date(), keyPattern: TRACKER_KEY_PATTERN, trackerUrlBase: TRACKER_URL_BASE, ...over,
  };
}

function main(argv: string[]): number {
  const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const t0 = performance.now();
  const opts = defaultOptions(Object.fromEntries([['ledger', flag('ledger')], ['project', flag('project')], ['statusDir', flag('status-dir')], ['out', flag('out')], ['html', flag('html')]].filter(([, v]) => v !== undefined)) as Partial<GenerateOptions>);
  if (!opts.ledger || !opts.out || opts.out === PAGE_FILE) { console.error('podium-slim: no ledger root or output path configured (set LEDGER_ROOT or pass --ledger and --out)'); return 1; }
  const r = generate(opts);
  console.log(`${r.wrote ? 'wrote' : 'unchanged'} ${r.out}: ${r.lines} lines in ${Math.round(performance.now() - t0)} ms`);
  return 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) process.exit(main(process.argv.slice(2)));
