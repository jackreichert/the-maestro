/**
 * The status page as text: a pure function of the ledger's board, the open PRs, the priorities file and the settings.
 * Nothing here reads a file, runs a command or knows an org, repo or vault by name; `generate.ts` supplies all of it.
 * The page is ids and counts only, never patient or personal data.
 */
import { obsidianUri, ticketNotePath } from './links.ts';
import { PRIORITIES_UNSET_LINE } from './priorities.ts';
import type { PrioritiesState } from './priorities.ts';

export interface Item { id: string; date: string; ts?: string; text: string; refs?: string[]; stream?: string; ticket?: string | null; gate?: string; deferredUntil?: string }
export interface Pr {
  number: number; title: string; url: string; isDraft: boolean; baseRefName: string; headRefName: string;
  mergeable: string; mergeStateStatus: string; reviewDecision: string | null;
  repo: string; short: string; owner: string; unresolved: number; ci: string; stream: string;
}
/** `journal.ts status --json`, the part the page reads. */
export interface BoardStatus { inflight: Item[]; blocked: Item[]; awaiting: Item[]; done: Item[] }
/** `journal.ts triage --json`, the part the page reads. */
export interface Triage { items: (Item & { gate?: string; deferredUntil?: string })[] }

/** Install-specific settings, all from local-config. */
export interface PageConfig {
  /** Stream names in display order; streams seen in the board are added after, `other` is last. */
  streams: string[];
  /** Short repo name to stream. */
  repoStreams: Record<string, string>;
  vaultName: string;
  trackerUrlBase: string;
  ticketNotePath: string;
  trackerKeyPattern: string;
  tz: string;
}

/** Where the PR list came from: when GitHub was last read (null when never), and why the read just now failed, if it did. */
export interface PrData { fetchedAt: Date | null; failure?: string }

export interface PageInput {
  now: Date;
  status: BoardStatus;
  triage: Triage;
  prs: Pr[];
  prData: PrData;
  /** ticket id to the ask ids it covers (Status/ticket-map.json). */
  ticketMap: Record<string, string[]>;
  priorities: PrioritiesState;
  config: PageConfig;
  /** The command words that regenerate the page, shown in the header. */
  command: string;
}

const OTHER = 'other';
const CELL_MAX = 60;

// ── small helpers ───────────────────────────────────────────────────────────

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-';
const oneLine = (s: string, max: number): string => {
  const t = s.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
};
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The date, an ISO timestamp with offset and a human label of `d` in the zone `tz` (the system zone when empty). */
export function zonedParts(d: Date, tz: string): { date: string; iso: string; human: string } {
  const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, ...opts });
  const p = Object.fromEntries(f({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const off = f({ timeZoneName: 'longOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  const abbr = f({ timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? '';
  const date = `${p.year}-${p.month}-${p.day}`;
  const hm = `${p.hour}:${p.minute}`;
  return { date, iso: `${date}T${hm}:${p.second}${off}`, human: `${date} ${hm} ${abbr}`.trim() };
}

/** `3:05 pm ET`: the clock time of `d` in `tz`, with the US zones' standard and daylight names folded to ET, CT, MT, PT. */
export function clockLabel(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).formatToParts(d);
  const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()} ${get('timeZoneName').replace(/^([ECMP])[SD]T$/, '$1T')}`.trim();
}

/** The clock time of `at` as `clockLabel` gives it, with the date in front when it is not the page's own day. */
export function prDataLabel(at: Date, now: Date, tz: string): string {
  const day = zonedParts(at, tz).date;
  return `${day === zonedParts(now, tz).date ? '' : `${day} `}${clockLabel(at, tz)}`;
}

/** The warning under the title when the PR read failed; empty lines when it did not. Says whether the tables are old or empty for lack of data. */
function prWarning(data: PrData, now: Date, tz: string): string[] {
  if (!data.failure) return [];
  const why = oneLine(data.failure, 120);
  const rest = data.fetchedAt
    ? `The PR tables below are from the last good read at ${prDataLabel(data.fetchedAt, now, tz)} and may be out of date.`
    : 'No earlier PR data is cached, so the PR tables below are empty because they could not be read, not because nothing is open.';
  return [`**Warning: GitHub could not be read (${why}). ${rest}**`, ''];
}

/** How long ago `iso` was, as `12 min`, `3 h` or `5 d`; empty when `iso` is missing or unreadable. */
export function ageLabel(iso: string | undefined, now: Date): string {
  const ms = iso ? now.getTime() - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
}

const keysIn = (cfg: PageConfig, s: string): string[] => [...new Set(s.replace(/\bCVE-\d+/g, '').match(new RegExp(cfg.trackerKeyPattern, 'g')) ?? [])];

interface Ref { label: string; url?: string }
const mdLink = (r: Ref): string => (r.url ? `[${r.label}](${r.url})` : r.label);
const trackerRef = (cfg: PageConfig, key: string): Ref => (cfg.trackerUrlBase ? { label: key, url: `${cfg.trackerUrlBase}${key}` } : { label: key });
const ticketNoteRef = (cfg: PageConfig, id: string): Ref =>
  (cfg.vaultName ? { label: id, url: obsidianUri(cfg.vaultName, ticketNotePath(cfg.ticketNotePath, id)) } : { label: id });

/** Stream names in display order. */
export function streamOrder(cfg: PageConfig, seen: (string | undefined)[]): string[] {
  const all = [...cfg.streams, ...Object.values(cfg.repoStreams), ...seen.filter((s): s is string => !!s && s !== 'none')];
  return [...new Set(all.filter((s) => s !== OTHER)), OTHER];
}

// ── PR rendering ────────────────────────────────────────────────────────────

const typePrefix = /^\w+(\([^)]*\))?!?:\s*/;
const twinSuffix = /\s*\((staging|develop)\)\s*$/i;
const titleKey = (p: Pr): string => `${p.repo}|${p.title.replace(typePrefix, '').replace(twinSuffix, '').trim().toLowerCase()}`;
const branchKey = (p: Pr): string => `${p.repo}|${p.headRefName.replace(/-(develop|staging)$/, '')}`;

/** The open PR whose head branch is this PR's base, if any (this PR is stacked on it). */
function stackParent(p: Pr, all: Pr[]): Pr | undefined {
  const c = all.filter((q) => q !== p && q.repo === p.repo && q.headRefName === p.baseRefName);
  return c.find((q) => q.baseRefName !== 'staging') ?? c[0];
}

function prRef(p: Pr, all: Pr[], withRepo: boolean): Ref {
  const parent = stackParent(p, all);
  return { label: `${withRepo ? p.short : ''}#${p.number} → ${parent ? `#${parent.number}, stacked` : p.baseRefName}`, url: p.url };
}

function prState(p: Pr): string {
  const ci = { SUCCESS: 'CI pass', FAILURE: '**CI FAIL**', ERROR: '**CI FAIL**', PENDING: 'CI pending', EXPECTED: 'CI pending', NONE: 'CI none' }[p.ci] ?? `CI ${p.ci}`;
  const merge = p.mergeable === 'CONFLICTING' ? '**CONFLICTING**' : p.mergeable === 'MERGEABLE' ? (p.mergeStateStatus === 'BEHIND' ? 'behind' : 'mergeable') : 'merge ?';
  const thr = p.unresolved ? `**${p.unresolved} thr**` : '0 thr';
  const rev = p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? '**changes requested**' : '';
  return [p.isDraft ? 'draft' : 'ready', ci, thr, merge, rev].filter(Boolean).join(', ');
}

interface Row { dev?: Pr; stg?: Pr }

/** Develop and staging PRs of one change: the same title or branch, else the only leftover pair in a repo sharing a tracker key. */
function pairTwins(cfg: PageConfig, prs: Pr[]): Row[] {
  const stg = prs.filter((p) => p.baseRefName === 'staging');
  const rest = prs.filter((p) => p.baseRefName !== 'staging');
  const twin = new Map<Pr, Pr>();
  for (const d of rest) {
    const t = stg.find((s) => ![...twin.values()].includes(s) && s.repo === d.repo && (titleKey(s) === titleKey(d) || branchKey(s) === branchKey(d)));
    if (t) twin.set(d, t);
  }
  const keyOf = (p: Pr): string => `${p.repo}|${keysIn(cfg, `${p.title} ${p.headRefName}`)[0] ?? p.number}`;
  const withKey = (list: Pr[], k: string): Pr[] => list.filter((p) => keyOf(p) === k);
  const freeDev = rest.filter((d) => !twin.has(d));
  const freeStg = stg.filter((s) => ![...twin.values()].includes(s));
  for (const d of freeDev) {
    const [only, ...more] = withKey(freeStg, keyOf(d));
    if (only && !more.length && withKey(freeDev, keyOf(d)).length === 1) twin.set(d, only);
  }
  const used = new Set(twin.values());
  const rows: Row[] = [...rest.map((d) => ({ dev: d, stg: twin.get(d) })), ...stg.filter((s) => !used.has(s)).map((s) => ({ stg: s }))];
  return rows.sort((x, y) => ((x.dev ?? x.stg)!.number) - ((y.dev ?? y.stg)!.number));
}

/** What needs a look on a PR: conflicts, failing CI, open threads, requested changes. Empty when nothing does. */
function prFlags(p: Pr): string {
  return [p.mergeable === 'CONFLICTING' ? '**CONFLICTING**' : '', p.ci === 'FAILURE' || p.ci === 'ERROR' ? '**CI FAIL**' : '',
    p.unresolved ? `**${p.unresolved} thr**` : '', p.reviewDecision === 'CHANGES_REQUESTED' ? '**changes requested**' : ''].filter(Boolean).join(' ');
}

/** One table per stream: ticket | develop PR (base) | staging twin (base, or none) | tl;dr. Streams with no open PR get no table. */
function prSection(cfg: PageConfig, prs: Pr[], streams: string[]): string[] {
  const tot = (f: (p: Pr) => boolean): number => prs.filter(f).length;
  const out = [`## Open PRs (${prs.length})`, '',
    `${tot((p) => p.isDraft)} draft, ${tot((p) => p.mergeable === 'CONFLICTING')} conflicting, ${tot((p) => p.unresolved > 0)} with unresolved threads, ${tot((p) => p.ci === 'FAILURE' || p.ci === 'ERROR')} failing CI.`, ''];
  for (const stream of streams) {
    const mine = prs.filter((p) => p.stream === stream);
    if (!mine.length) continue;
    const multiRepo = new Set(mine.map((p) => p.repo)).size > 1;
    out.push(`### ${stream} (${mine.length})`, '', '| Ticket | Develop PR (base) | Staging twin (base) | TL;DR |', '|---|---|---|---|');
    for (const r of pairTwins(cfg, mine)) {
      const lead = (r.dev ?? r.stg)!;
      const key = keysIn(cfg, `${lead.title} ${lead.headRefName}`)[0];
      const prCell = (p: Pr | undefined, none: string): string => (p ? [mdLink(prRef(p, prs, multiRepo)), prFlags(p)].filter(Boolean).join(' ') : none);
      out.push(`| ${key ? mdLink(trackerRef(cfg, key)) : '-'} | ${prCell(r.dev, '-')} | ${prCell(r.stg, 'none')} | ${cell(oneLine(lead.title.replace(typePrefix, '').replace(twinSuffix, ''), 70))} |`);
    }
    out.push('');
  }
  return [...out, ...stackDiagram(prs)];
}

function stackDiagram(prs: Pr[]): string[] {
  const edges = prs.map((p) => [stackParent(p, prs), p] as const).filter(([a]) => a);
  if (!edges.length) return [];
  const node = (p: Pr): string => `${p.short.replace(/\W/g, '')}_${p.number}`;
  const lines = ['### Stacks', '', '```mermaid', 'graph LR'];
  const seen = new Set<Pr>();
  for (const [a, b] of edges) {
    for (const p of [a!, b]) if (!seen.has(p)) { seen.add(p); lines.push(`  ${node(p)}["${p.short}#${p.number}${stackParent(p, prs) ? '' : ` (base ${p.baseRefName})`}"]`); }
    lines.push(`  ${node(a!)} --> ${node(b)}`);
  }
  return [...lines, '```', ''];
}

// ── asks ────────────────────────────────────────────────────────────────────

/** Short names a repo goes by in ask text: its own and the part after its first hyphen (`acme-widgets` also as `widgets`). */
function repoHints(cfg: PageConfig): Array<[RegExp, string]> {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Object.keys(cfg.repoStreams).map((repo) => {
    const tail = repo.includes('-') ? repo.slice(repo.indexOf('-') + 1) : '';
    return [new RegExp(`\\b(${[repo, tail].filter((n) => n.length > 3).map(esc).join('|')})\\b`), repo];
  });
}

/** The PRs, tracker keys and ticket note an ask refers to, as { label, url } references. */
function askRefs(cfg: PageConfig, a: Item, prs: Pr[], ticket: string | undefined): { prs: Ref[]; tracker: Ref[]; note?: Ref } {
  const hint = repoHints(cfg).find(([re]) => re.test(a.text))?.[1];
  const streamRepo = Object.entries(cfg.repoStreams).find(([, s]) => s === a.stream)?.[0];
  const refs: Ref[] = [];
  const nums = [...new Set([...a.text.matchAll(/(?:\/pull\/|#)(\d{2,5})\b/g)].map((m) => Number(m[1])))];
  for (const n of nums) {
    const all = prs.filter((p) => p.number === n);
    const pick = (repo?: string): Pr[] => (repo ? all.filter((p) => p.short === repo) : all);
    const m = [hint, streamRepo].map(pick).find((x) => x.length === 1) ?? (all.length === 1 && !hint ? all : []);
    refs.push(m[0] ? prRef(m[0], prs, false) : { label: `#${n} (not open)` });
  }
  return { prs: refs, tracker: keysIn(cfg, a.text).map((k) => trackerRef(cfg, k)), note: ticket ? ticketNoteRef(cfg, ticket) : undefined };
}

/** The decision an ask puts to the user (up to its first question mark) and the context after it. */
export function splitAsk(text: string): { needed: string; context: string } {
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const q = clean.indexOf('?');
  return q === -1 ? { needed: clean, context: '' } : { needed: clean.slice(0, q + 1), context: clean.slice(q + 1).trim() };
}

/** One table of every ask, tagged with its stream, then under it one reply line per ask with its links and a `> answer:` stub. */
function asksSection(cfg: PageConfig, asks: Item[], prs: Pr[], tickets: Map<string, string>, streams: string[], today: string): string[] {
  const out = [`## Needs attention now (${asks.length})`, ''];
  if (!asks.length) return [...out, 'Nothing awaiting.', ''];
  const askStream = (a: Item): string => (streams.includes(a.stream ?? '') ? a.stream! : OTHER);
  const ordered = streams.flatMap((s) => asks.filter((a) => askStream(a) === s));
  out.push('| Id | Stream | Context | Ticket | Needed from you |', '|---|---|---|---|---|');
  const replies: string[] = [];
  for (const a of ordered) {
    const refs = askRefs(cfg, a, prs, a.ticket || tickets.get(a.id));
    const { needed, context } = splitAsk(a.text);
    const age = daysBetween(a.date, today);
    const tl = [oneLine(context, 110), age > 3 ? `_${age} days old_` : ''].filter(Boolean).join(' ');
    const ticket = [...(refs.note ? [refs.note] : []), ...refs.tracker.slice(0, 2)].map(mdLink).join(' · ');
    out.push(`| \`${a.id}\` | ${askStream(a)} | ${cell(tl)} | ${ticket || '-'} | ${cell(oneLine(needed, 130))} |`);
    const links = [...refs.prs, ...refs.tracker, ...(refs.note ? [refs.note] : [])].filter((r) => r.url).map(mdLink);
    replies.push(`- [ ] \`${a.id}\`${links.length ? ` ${links.join(' · ')}` : ''}`, '  > answer: ');
  }
  return [...out, '', ...replies, ''];
}

// ── priorities ──────────────────────────────────────────────────────────────

/** The block under the title: today's list with per-stream counts, or the not-set banner. */
function prioritiesSection(cfg: PageConfig, state: PrioritiesState, asks: Item[], inflight: Item[], prs: Pr[], streams: string[]): string[] {
  const out = ["## Today's priorities", ''];
  if (state.state !== 'ok') return [...out, `**${PRIORITIES_UNSET_LINE}**`, ''];
  const norm = (s: string): string => s.toLowerCase();
  state.items.forEach((p, i) => {
    const stream = p.stream ? streams.find((s) => norm(s) === norm(p.stream ?? '')) : undefined;
    const inS = (it: Item): boolean => (streams.includes(it.stream ?? '') ? it.stream : OTHER) === stream;
    const counts = stream ? ` _[${stream}: awaiting ${asks.filter(inS).length} · in flight ${inflight.filter(inS).length} · open PRs ${prs.filter((x) => x.stream === stream).length}]_` : '';
    out.push(`${i + 1}. ${p.text}${counts}`);
  });
  return [...out, `Set for ${state.date}.`, ''];
}

// ── page ────────────────────────────────────────────────────────────────────

const li = (a: Item): string => `- \`${a.id}\` ${oneLine(a.text, 200)}`;

/** The whole page. */
export function renderPage(input: PageInput): { page: string; date: string } {
  const { now, status, triage, prs, prData, ticketMap, priorities, config: cfg, command } = input;
  const tickets = new Map<string, string>();
  for (const [t, list] of Object.entries(ticketMap)) for (const id of list) tickets.set(id, t);
  const meta = new Map(triage.items.map((i) => [i.id, i]));
  const asks: Item[] = status.awaiting.map((a) => ({ ...a, ticket: a.ticket ?? meta.get(a.id)?.ticket }));
  const blocked: Item[] = status.blocked.map((b) => ({ ...b, gate: meta.get(b.id)?.gate }));
  const deferred = triage.items.filter((i) => i.deferredUntil);
  const prPriorityStreams = priorities.state === 'ok' ? priorities.items.map((p) => p.stream) : [];
  const streams = streamOrder(cfg, [...asks.map((a) => a.stream), ...status.inflight.map((i) => i.stream), ...prs.map((p) => p.stream), ...prPriorityStreams]);
  const t = zonedParts(now, cfg.tz);
  const age = (i: Item): string => ageLabel(i.ts, now);
  const withAge = (i: Item, extra: string): string => `${li(i)}${extra} · ${age(i) || 'age unknown'}`;
  const doneAt = (i: Item): string => (i.ts && Number.isFinite(Date.parse(i.ts)) ? ` · ${clockLabel(new Date(i.ts), cfg.tz)}` : '');
  const section = (title: string, rows: string[]): string[] => [`### ${title} (${rows.length})`, '', ...(rows.length ? rows : ['None.']), ''];

  const page = [
    '---', 'type: status', `updated: ${t.iso}`, '---', '',
    '# Status now', '',
    `Updated ${clockLabel(now, cfg.tz)} (${t.date}). Regenerated by \`${command}\`.`, '',
    ...prWarning(prData, now, cfg.tz),
    ...prioritiesSection(cfg, priorities, asks, status.inflight, prs, streams),
    ...asksSection(cfg, asks, prs, tickets, streams, t.date),
    ...prSection(cfg, prs, streams),
    '## Other status and findings', '',
    ...section('In flight', status.inflight.map((i) => withAge(i, ` [${i.stream ?? OTHER}]`))),
    ...section('Blocked', blocked.map((b) => withAge(b, ` (gate: ${b.gate ?? 'none recorded'})`))),
    ...section('Recent done', status.done.map((d) => `${li(d)}${doneAt(d)}`)),
    ...section('Deferred', deferred.map((d) => `${li(d)} (until ${d.deferredUntil})`)),
  ].join('\n');
  return { page, date: t.date };
}
