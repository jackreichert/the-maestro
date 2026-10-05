/**
 * The status page as text: a pure function of the ledger's board, the open PRs, the priorities file and the settings.
 * Nothing here reads a file, runs a command or knows an org, repo or vault by name; `generate.ts` supplies all of it.
 * The page is ids and counts only, never patient or personal data.
 */
import { obsidianUri, ticketNotePath } from './links.ts';
import { PRIORITIES_UNSET_LINE } from './priorities.ts';
import type { PrioritiesState } from './priorities.ts';

export interface Item { id: string; date: string; text: string; stream?: string; ticket?: string | null; gate?: string; deferredUntil?: string }
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

export interface PageInput {
  now: Date;
  status: BoardStatus;
  triage: Triage;
  prs: Pr[];
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

function pairTwins(prs: Pr[]): Row[] {
  const stg = prs.filter((p) => p.baseRefName === 'staging');
  const rest = prs.filter((p) => p.baseRefName !== 'staging');
  const used = new Set<Pr>();
  const rows: Row[] = [];
  for (const d of rest) {
    const t = stg.find((s) => !used.has(s) && s.repo === d.repo && (titleKey(s) === titleKey(d) || branchKey(s) === branchKey(d)));
    if (t) used.add(t);
    rows.push({ dev: d, stg: t });
  }
  for (const s of stg) if (!used.has(s)) rows.push({ stg: s });
  return rows.sort((a, b) => ((a.dev ?? a.stg)!.number) - ((b.dev ?? b.stg)!.number));
}

function prBoard(cfg: PageConfig, prs: Pr[], stream: string, multiRepo: boolean): string[] {
  const mine = prs.filter((p) => p.stream === stream);
  if (!mine.length) return [`### ${stream}`, '', 'No open PRs.', ''];
  const out = [`### ${stream}`, '', '| Ticket | Develop PR | Twin (staging) PR | TL;DR | State |', '|---|---|---|---|---|'];
  for (const r of pairTwins(mine)) {
    const lead = (r.dev ?? r.stg)!;
    const key = keysIn(cfg, `${lead.title} ${lead.headRefName}`)[0];
    const tl = oneLine(lead.title.replace(typePrefix, '').replace(twinSuffix, ''), 70);
    const state = r.dev && r.stg ? `dev: ${prState(r.dev)}<br>stg: ${prState(r.stg)}` : prState(lead);
    const prCell = (p?: Pr): string => (p ? mdLink(prRef(p, prs, multiRepo)) : '-');
    out.push(`| ${key ? mdLink(trackerRef(cfg, key)) : '-'} | ${prCell(r.dev)} | ${prCell(r.stg)} | ${cell(tl)} | ${state} |`);
  }
  return [...out, ''];
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

/** One row per ask with short cells, then one reply line per ask under the table: the links (which are long) and an answer stub. */
function asksSection(cfg: PageConfig, asks: Item[], prs: Pr[], tickets: Map<string, string>, streams: string[]): string[] {
  const out = [`## Needs you (${asks.length})`, ''];
  for (const s of streams) {
    const mine = asks.filter((a) => (streams.includes(a.stream ?? '') ? a.stream : OTHER) === s);
    out.push(`### ${s} (${mine.length})`, '');
    if (!mine.length) { out.push('Nothing awaiting.', ''); continue; }
    out.push('| Id | Decision | Ticket | PR (base) |', '|---|---|---|---|');
    const replies: string[] = [];
    for (const a of mine) {
      const refs = askRefs(cfg, a, prs, a.ticket || tickets.get(a.id));
      const shownPrs = refs.prs.slice(0, 3).map((r) => r.label).join('; ') + (refs.prs.length > 3 ? ` +${refs.prs.length - 3}` : '');
      out.push(`| \`${a.id}\` | ${cell(oneLine(a.text, CELL_MAX))} | ${refs.note?.label ?? refs.tracker[0]?.label ?? '-'} | ${shownPrs || '-'} |`);
      const links = [...refs.prs, ...refs.tracker, ...(refs.note ? [refs.note] : [])].filter((r) => r.url).map(mdLink);
      replies.push(`- [ ] \`${a.id}\`${links.length ? ` ${links.join(' · ')}` : ''}`, '  > answer: ');
    }
    out.push('', ...replies, '');
  }
  return out;
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
  return [...out, ''];
}

// ── page ────────────────────────────────────────────────────────────────────

const li = (a: Item): string => `- \`${a.id}\` ${oneLine(a.text, 200)}`;

function attention(cfg: PageConfig, prs: Pr[], asks: Item[], today: string): string[] {
  const lines: string[] = [];
  for (const p of prs) {
    const flags = [
      p.mergeable === 'CONFLICTING' ? 'CONFLICTING' : '',
      p.unresolved ? `${p.unresolved} unresolved threads` : '',
      p.ci === 'FAILURE' || p.ci === 'ERROR' ? 'CI failing' : '',
    ].filter(Boolean);
    if (flags.length) lines.push(`- ${mdLink(prRef(p, prs, true))} ${flags.join(', ')}: ${oneLine(p.title.replace(typePrefix, ''), 60)}`);
  }
  for (const a of asks) {
    const age = daysBetween(a.date, today);
    if (age > 3) lines.push(`- ask \`${a.id}\` is ${age} days old: ${oneLine(a.text, 90)}`);
  }
  return ['## Needs attention now', '', ...(lines.length ? lines : ['Nothing needs attention.']), ''];
}

/** The whole page. */
export function renderPage(input: PageInput): { page: string; date: string } {
  const { now, status, triage, prs, ticketMap, priorities, config: cfg, command } = input;
  const tickets = new Map<string, string>();
  for (const [t, list] of Object.entries(ticketMap)) for (const id of list) tickets.set(id, t);
  const meta = new Map(triage.items.map((i) => [i.id, i]));
  const asks: Item[] = status.awaiting.map((a) => ({ ...a, ticket: a.ticket ?? meta.get(a.id)?.ticket }));
  const blocked: Item[] = status.blocked.map((b) => ({ ...b, gate: meta.get(b.id)?.gate }));
  const deferred = triage.items.filter((i) => i.deferredUntil);
  const prPriorityStreams = priorities.state === 'ok' ? priorities.items.map((p) => p.stream) : [];
  const streams = streamOrder(cfg, [...asks.map((a) => a.stream), ...status.inflight.map((i) => i.stream), ...prs.map((p) => p.stream), ...prPriorityStreams]);
  const t = zonedParts(now, cfg.tz);
  const askStream = (a: Item): string => (streams.includes(a.stream ?? '') ? a.stream! : OTHER);
  const counts = streams.map((s) => `${s} ${asks.filter((a) => askStream(a) === s).length}`).join(', ');
  const tot = (f: (p: Pr) => boolean): number => prs.filter(f).length;
  const multiRepo = (s: string): boolean => new Set(prs.filter((p) => p.stream === s).map((p) => p.repo)).size > 1;

  const page = [
    '---', 'type: status', `updated: ${t.iso}`, '---', '',
    '# Status now', '',
    ...prioritiesSection(cfg, priorities, asks, status.inflight, prs, streams),
    `Generated ${t.human}. Regenerated by \`${command}\`.`, '',
    `Awaiting you: ${asks.length} (${counts}). Open PRs: ${prs.length} (${tot((p) => p.isDraft)} draft, ${tot((p) => p.mergeable === 'CONFLICTING')} conflicting, ${tot((p) => p.unresolved > 0)} with unresolved threads, ${tot((p) => p.ci === 'FAILURE' || p.ci === 'ERROR')} failing CI).`, '',
    ...attention(cfg, prs, asks, t.date),
    ...asksSection(cfg, asks, prs, tickets, streams),
    '## PR board', '',
    ...streams.flatMap((s) => prBoard(cfg, prs, s, multiRepo(s))),
    ...stackDiagram(prs),
    `## In flight (${status.inflight.length})`, '', ...(status.inflight.length ? status.inflight.map((i) => `${li(i)} [${i.stream ?? OTHER}]`) : ['None.']), '',
    `## Blocked (${blocked.length})`, '', ...(blocked.length ? blocked.map((b) => `${li(b)} (gate: ${b.gate ?? 'none recorded'})`) : ['None.']), '',
    `## Deferred (${deferred.length})`, '', ...(deferred.length ? deferred.map((d) => `${li(d)} (until ${d.deferredUntil})`) : ['None.']), '',
    `## Done today (${status.done.length})`, '', ...(status.done.length ? status.done.map(li) : ['None.']), '',
    '---', '',
    'Agents are not listed (they are session state).', '',
  ].join('\n');
  return { page, date: t.date };
}
