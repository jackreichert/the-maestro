/**
 * The status page as text: a pure function of the ledger's board, the open PRs, the priorities file and the settings.
 * Nothing here reads a file, runs a command or knows an org, repo or vault by name; `generate.ts` supplies all of it.
 * The page is ids and counts only, never patient or personal data.
 */
import { linkNotePaths, obsidianUri, ticketNotePath } from './links.ts';
import type { NoteLinkEnv } from './links.ts';
import { PRIORITIES_UNSET_LINE } from './priorities.ts';
import type { PrioritiesState } from './priorities.ts';
import { reviewQueue } from '../review-queue.ts';
import { splitSelfReview } from '../self-review.ts';
import type { ReviewQueue } from '../review-queue.ts';
import { sessionText } from '../session-text.ts';
import type { SessionStatus } from '../session-text.ts';
import type { FooterRow } from '../journal/board.ts';
import { askBits, asksNote } from '../journal/ask-fields.ts';
import { startLines } from '../start/start-here.ts';
import type { StartHere } from '../start/start-here.ts';

export interface Item { id: string; date: string; ts?: string; stateTs?: string; text: string; model?: string; refs?: string[]; stream?: string; ticket?: string | null; gate?: string; deferredUntil?: string;
  /** An ask's decision fields as the ledger stores them; unchecked here, `askBits` reads each one defensively. */
  recommend?: unknown; default?: unknown; door?: unknown; by?: unknown; class?: unknown;
  /** A paste ask's block file: set only on `status.paste` rows. */
  paste?: unknown }
export interface Pr {
  number: number; title: string; url: string; isDraft: boolean; baseRefName: string; headRefName: string;
  mergeable: string; mergeStateStatus: string; reviewDecision: string | null;
  repo: string; short: string; owner: string; unresolved: number; ci: string; stream: string;
}
/** The numbers `journal.ts status --footer` prints, as `status --json` carries them: one row per stream, and the session. */
export interface FooterData { ledger: FooterRow[]; session: SessionStatus }
/** `journal.ts status --json`, the part the page reads. */
export interface BoardStatus { inflight: Item[]; queued: Item[]; blocked: Item[]; awaiting: Item[]; /** Run-this asks; older boards omit it. */ paste?: Item[]; done: Item[]; footer?: FooterData }
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
  /** The page's own project: a bare note path in ask text is looked up under `Projects/<project>/` too. */
  project?: string;
  /** Whether a vault-relative `.md` path exists in the vault. Absent: note paths in text are not linked. */
  noteExists?: (vaultPath: string) => boolean;
  /** The review queue cap (`review_queue_cap`). Absent: the page shows no review queue line. */
  reviewQueueCap?: number;
  /** `self_review_repos`: PRs in these repos are not counted in the review queue. Absent: none. */
  selfReviewRepos?: string[];
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
  /** `journal.ts start-here --json` for the Start block; `startFailure` says why it is absent. Neither is set for a reader that only needs the board. */
  start?: StartHere;
  startFailure?: string;
  /** The command words that regenerate the page, shown in the header. */
  command: string;
}

const OTHER = 'other';
const CELL_MAX = 60;

// ── small helpers ───────────────────────────────────────────────────────────

/** Text safe in a table cell: whitespace squashed, and each character Markdown would read as markup (pipe, backslash, emphasis, code, brackets, angle brackets, strikethrough) backslash-escaped. */
const cell = (s: string): string => s.replace(/[|\\*_`<>[\]~]/g, '\\$&').replace(/\s+/g, ' ').trim() || '-';
/** `s` without URLs (any `scheme://...`) and without any `obsidian:` target: the page's own obsidian links are built by `linkNotePaths` from existing vault paths, never carried in from ledger or GitHub text. */
const dropLinks = (s: string): string => s.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|obsidian:)\S*/gi, '');
/** Ask text only: also drops bare `repo/pull/N` fragments left when a URL was shortened (askRefs links the PR back as `#N`); the punctuation after N stays. */
const dropPullFragments = (s: string): string => dropLinks(s).replace(/\S*\/pulls?\/\d+(?!\d)/g, '');
/** `s` without URLs, squashed to one line; over `max` it is cut at a word boundary (never mid-word) and ends in `...`. */
const oneLine = (s: string, max: number): string => {
  const t = dropLinks(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const room = t.slice(0, max - 3);
  const i = room.lastIndexOf(' ');
  const atWord = t[max - 3] === ' ' ? room : (i > 0 ? room.slice(0, i) : room);
  return `${atWord.trimEnd()}...`;
};
/** The text with URLs dropped and whitespace squashed, never clipped. */
const plain = (s: string): string => dropLinks(s).replace(/\s+/g, ' ').trim();
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

export const keysIn = (cfg: PageConfig, s: string): string[] => [...new Set(s.replace(/\bCVE-\d+/g, '').match(new RegExp(cfg.trackerKeyPattern, 'g')) ?? [])];

/** `nowrap` keeps an id such as `ABC-123` on one line: a narrow table column would otherwise break it at the hyphen. */
export interface Ref { label: string; url?: string; nowrap?: boolean }
const mdLink = (r: Ref): string => {
  const text = r.url ? `[${r.label}](${r.url})` : r.label;
  return r.nowrap ? `<span style="white-space:nowrap">${text}</span>` : text;
};
export const trackerRef = (cfg: PageConfig, key: string): Ref => (cfg.trackerUrlBase ? { label: key, url: `${cfg.trackerUrlBase}${key}`, nowrap: true } : { label: key, nowrap: true });
export const ticketNoteRef = (cfg: PageConfig, id: string): Ref =>
  (cfg.vaultName ? { label: id, url: obsidianUri(cfg.vaultName, ticketNotePath(cfg.ticketNotePath, id)), nowrap: true } : { label: id, nowrap: true });

/** The lookup `linkNotePaths` needs for `item`: a bare note path belongs to the project of its ticket (the id minus its number, as `ticketNotePath` reads it), else its stream's repo, else the page's project. */
function noteEnv(cfg: PageConfig, item: Item, ticket?: string): NoteLinkEnv | undefined {
  if (!cfg.noteExists) return undefined;
  const streamRepos = Object.entries(cfg.repoStreams).filter(([, s]) => s === item.stream).map(([repo]) => repo);
  const projects = [ticket?.replace(/-\d+$/, ''), ...streamRepos, cfg.project].filter((p): p is string => !!p);
  return { vaultName: cfg.vaultName, projects, exists: cfg.noteExists };
}
/** Markdown-markup escapes only (no trim or squash), for the stretches between linked note paths. */
const escCell = (s: string): string => s.replace(/[|\\*_`<>[\]~]/g, '\\$&');
const escBold = (s: string): string => s.replace(/[\\*_`[\]<>]/g, '\\$&');

/** An in-flight or queued item's text as a table cell: clipped to one line, with existing note paths linked. */
const workText = (cfg: PageConfig, i: Item, ticket: string | undefined): string => {
  const linked = linkNotePaths(oneLine(i.text, 110), noteEnv(cfg, i, ticket), escCell);
  return linked.trim() || '-';
};

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
export function stackParent(p: Pr, all: Pr[]): Pr | undefined {
  const c = all.filter((q) => q !== p && q.repo === p.repo && q.headRefName === p.baseRefName);
  return c.find((q) => q.baseRefName !== 'staging') ?? c[0];
}

/** A PR link as `#123`, with its base (`→ develop`, or `→ #120, stacked`) only where `withBase` is set: the Open PRs tables show the base, the asks do not. */
function prRef(p: Pr, all: Pr[], withRepo: boolean, withBase = true): Ref {
  const parent = stackParent(p, all);
  const base = withBase ? ` → ${parent ? `#${parent.number}, stacked` : p.baseRefName}` : '';
  return { label: `${withRepo ? p.short : ''}#${p.number}${base}`, url: p.url, nowrap: true };
}

function prState(p: Pr): string {
  const ci = { SUCCESS: 'CI pass', FAILURE: '**CI FAIL**', ERROR: '**CI FAIL**', PENDING: 'CI pending', EXPECTED: 'CI pending', NONE: 'CI none' }[p.ci] ?? `CI ${p.ci}`;
  const merge = p.mergeable === 'CONFLICTING' ? '**CONFLICTING**' : p.mergeable === 'MERGEABLE' ? (p.mergeStateStatus === 'BEHIND' ? 'behind' : 'mergeable') : 'merge ?';
  const thr = p.unresolved ? `**${p.unresolved} thr**` : '0 thr';
  const rev = p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? '**changes requested**' : '';
  return [p.isDraft ? 'draft' : 'ready', ci, thr, merge, rev].filter(Boolean).join(', ');
}

export interface Row { dev?: Pr; stg?: Pr }

/** Develop and staging PRs of one change: the same title or branch, else the only leftover pair in a repo sharing a tracker key. */
export function pairTwins(cfg: PageConfig, prs: Pr[]): Row[] {
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

/** What needs a look on a PR, as plain names: conflicts, failing CI, open threads, requested changes. Empty when nothing does. */
export function prFlagNames(p: Pr): string[] {
  return [p.mergeable === 'CONFLICTING' ? 'CONFLICTING' : '', p.ci === 'FAILURE' || p.ci === 'ERROR' ? 'CI FAIL' : '',
    p.unresolved ? `${p.unresolved} thr` : '', p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : ''].filter(Boolean);
}

/** `prFlagNames` in bold Markdown, space-separated. */
function prFlags(p: Pr): string {
  return prFlagNames(p).map((f) => `**${f}**`).join(' ');
}

/** `Review queue: 3 of 4 ...`: the non-draft PRs waiting on a review against the cap, and what a full queue means for dispatch. */
const queueSentence = (q: ReviewQueue): string => `**Review queue: ${q.count} of ${q.cap}${q.full ? ' (full)' : ''}**${q.full ? ': dispatch only fixes to PRs already open until it drops.' : ' non-draft PRs awaiting review.'}`;

/** Where a self-review PR stands for its one reviewer, first match: new comments, draft, ready to merge, approved but held, awaiting review. The same buckets as `prs-snapshot.ts --ready`. */
export function selfReviewState(p: Pr): string {
  if (p.unresolved > 0) return 'new comments';
  if (p.isDraft) return 'draft for you';
  if (p.reviewDecision === 'APPROVED') return p.mergeable === 'MERGEABLE' ? 'ready to merge' : 'approved, not ready';
  return 'awaiting your review';
}

/** One table per stream: ticket | develop PR (base) | staging twin (base, or none) | tl;dr. Streams with no open PR get no table. PRs in a self-review repo are listed apart, after. */
function prSection(cfg: PageConfig, all: Pr[], streams: string[]): string[] {
  const { org: prs, self } = splitSelfReview(all, cfg.selfReviewRepos ?? []);
  const tot = (f: (p: Pr) => boolean): number => prs.filter(f).length;
  const out = [`## Open PRs (${prs.length})`, '',
    `${tot((p) => p.isDraft)} draft, ${tot((p) => p.mergeable === 'CONFLICTING')} conflicting, ${tot((p) => p.unresolved > 0)} with unresolved threads, ${tot((p) => p.ci === 'FAILURE' || p.ci === 'ERROR')} failing CI.`, '',
    ...(cfg.reviewQueueCap === undefined ? [] : [queueSentence(reviewQueue(prs, cfg.reviewQueueCap)), ''])];
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
  return [...out, ...stackDiagram(prs), ...selfReviewSection(self, all)];
}

/** The Maestro PRs (self-review) section: PRs only their owner reviews, with where each stands. Empty when there are none. */
function selfReviewSection(self: Pr[], all: Pr[]): string[] {
  if (!self.length) return [];
  return [`## Maestro PRs (self-review) (${self.length})`, '', 'Not counted in the review queue. Only you review these.', '', '| PR | State | TL;DR |', '|---|---|---|',
    ...self.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number).map((p) => `| ${[mdLink(prRef(p, all, true)), prFlags(p)].filter(Boolean).join(' ')} | ${selfReviewState(p)} | ${cell(oneLine(p.title.replace(typePrefix, '').replace(twinSuffix, ''), 70))} |`), ''];
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
export function askRefs(cfg: PageConfig, a: Item, prs: Pr[], ticket: string | undefined): { prs: Ref[]; tracker: Ref[]; note?: Ref } {
  const hint = repoHints(cfg).find(([re]) => re.test(a.text))?.[1];
  const streamRepo = Object.entries(cfg.repoStreams).find(([, s]) => s === a.stream)?.[0];
  const refs: Ref[] = [];
  const nums = [...new Set([...a.text.matchAll(/(?:\/pull\/|#)(\d{1,6})\b/g)].map((m) => Number(m[1])))];
  for (const n of nums) {
    const all = prs.filter((p) => p.number === n);
    const pick = (repo?: string): Pr[] => (repo ? all.filter((p) => p.short === repo) : all);
    const m = [hint, streamRepo].map(pick).find((x) => x.length === 1) ?? (all.length === 1 && !hint ? all : []);
    refs.push(m[0] ? prRef(m[0], prs, false, false) : { label: `#${n} (not open)` });
  }
  return { prs: refs, tracker: keysIn(cfg, a.text).map((k) => trackerRef(cfg, k)), note: ticket ? ticketNoteRef(cfg, ticket) : undefined };
}

/** The text safe inside a `**...**` wrap: each emphasis, code, escape, bracket and angle-bracket character backslash-escaped, so the bold span ends where the page says it does and `snake_case` still reads as written. status-watch undoes the escapes. */
const boldSafe = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/[\\*_`[\]<>]/g, '\\$&');

/** The decision an ask puts to the user (up to its first question mark) and the context after it. */
export function splitAsk(text: string): { needed: string; context: string } {
  const clean = dropPullFragments(text).replace(/\s+/g, ' ').trim();
  const q = clean.indexOf('?');
  return q === -1 ? { needed: clean, context: '' } : { needed: clean.slice(0, q + 1), context: clean.slice(q + 1).trim() };
}

/**
 * Every ask, grouped under its stream's heading, one list item each: the ledger id, the full decision, its context, the
 * links, and the age when old. The `> answer:` stub is the line directly under the item (inline.ts reads it back by
 * that shape), so the reply sits with the ask. Text is never clipped: the full ask stays readable.
 */
function asksSection(cfg: PageConfig, asks: Item[], prs: Pr[], tickets: Map<string, string>, streams: string[], today: string): string[] {
  const out = [`## Needs attention now (${asks.length})`, ''];
  if (!asks.length) return [...out, 'Nothing awaiting.', ''];
  const askStream = (a: Item): string => (streams.includes(a.stream ?? '') ? a.stream! : OTHER);
  for (const stream of streams) {
    const mine = asks.filter((a) => askStream(a) === stream);
    if (!mine.length) continue;
    out.push(`### ${stream} (${mine.length})`, '');
    for (const a of mine) {
      const refs = askRefs(cfg, a, prs, a.ticket || tickets.get(a.id));
      const { needed, context } = splitAsk(a.text);
      const env = noteEnv(cfg, a, a.ticket || tickets.get(a.id));
      const age = daysBetween(a.date, today);
      const links = [...(refs.note ? [refs.note] : []), ...refs.tracker, ...refs.prs].map(mdLink).join(' · ');
      const bold = linkNotePaths(needed, env, escBold);
      const text = [boldSafe(needed) ? `**${bold}**` : '', linkNotePaths(plain(context), env, escLinkChars)].filter(Boolean).join(' ');
      const fields = askBits(a).map((b) => boldSafe(dropLinks(b).replace(/\bwww\.\S*/gi, ''))).join(' · ');
      out.push(`- [ ] \`${a.id}\` ${[text, links ? `(${links})` : '', fields ? `_${fields}_` : '', age > 3 ? `_${age} days old_` : ''].filter(Boolean).join(' ')}`, '  > answer: ');
    }
    out.push('');
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
  return [...out, `Set for ${state.date}.`, ''];
}

// ── working on now ──────────────────────────────────────────────────────────

/** One table of the in-flight ledger items, grouped by stream: id, what, ticket, model and how long it has run. Read-only: nothing here is an answer area. */
function workingSection(cfg: PageConfig, inflight: Item[], tickets: Map<string, string>, streams: string[], now: Date): string[] {
  const out = [`## Working on now (${inflight.length})`, ''];
  if (!inflight.length) return [...out, 'Nothing in flight.', ''];
  const streamOf = (i: Item): string => (streams.includes(i.stream ?? '') ? i.stream! : OTHER);
  const running = (i: Item): string => {
    const since = i.stateTs ?? i.ts;   // a promoted item runs from its start, not from when it was queued
    const age = ageLabel(since, now);
    return age ? `${age} (since ${prDataLabel(new Date(since as string), now, cfg.tz)})` : 'age unknown';
  };
  out.push('| Stream | Id | Working on | Ticket | Model | Running |', '|---|---|---|---|---|---|');
  for (const i of streams.flatMap((s) => inflight.filter((x) => streamOf(x) === s))) {
    const note = i.ticket || tickets.get(i.id);
    const refs = [...(note ? [ticketNoteRef(cfg, note)] : []), ...keysIn(cfg, i.text).slice(0, 2).map((k) => trackerRef(cfg, k))].map(mdLink).join(' · ');
    out.push(`| ${cell(streamOf(i))} | \`${i.id}\` | ${workText(cfg, i, note)} | ${refs || '-'} | ${cell(i.model ?? '')} | ${cell(running(i))} |`);
  }
  return [...out, ''];
}

// ── queued ──────────────────────────────────────────────────────────────────

/** One table of the queued ledger items (to-dos not started), grouped by stream: id, what, ticket and how long each has waited. Read-only: nothing here is an answer area. */
function queuedSection(cfg: PageConfig, queued: Item[], tickets: Map<string, string>, streams: string[], now: Date): string[] {
  const out = [`## Queued (${queued.length})`, ''];
  if (!queued.length) return [...out, 'Nothing queued.', ''];
  const streamOf = (i: Item): string => (streams.includes(i.stream ?? '') ? i.stream! : OTHER);
  out.push('| Stream | Id | What | Ticket | Queued for |', '|---|---|---|---|---|');
  for (const i of streams.flatMap((s) => queued.filter((x) => streamOf(x) === s))) {
    const note = i.ticket || tickets.get(i.id);
    const refs = [...(note ? [ticketNoteRef(cfg, note)] : []), ...keysIn(cfg, i.text).slice(0, 2).map((k) => trackerRef(cfg, k))].map(mdLink).join(' · ');
    out.push(`| ${cell(streamOf(i))} | \`${i.id}\` | ${workText(cfg, i, note)} | ${refs || '-'} | ${cell(ageLabel(i.stateTs ?? i.ts, now) || 'age unknown')} |`);
  }
  return [...out, ''];
}

// ── status (the chat footer, unrolled) ──────────────────────────────────────

/** The reply footer's numbers as a table, one row per stream, then the agents and session lines. Formatted from the data `status --json` carries, never recounted. */
function statusSection(footer: FooterData | undefined, inflight: Item[]): string[] {
  const out = ['## Status', ''];
  if (!footer) return [...out, '**Footer data unavailable:** `journal.ts status --json` carried no `footer`.', ''];
  out.push('| Stream | Done today | In flight | Queued | Awaiting you | To run | Blocked |', '|---|---|---|---|---|---|---|');
  for (const r of footer.ledger) out.push(`| ${cell(r.name ?? 'all')} | ${r.done} | ${r.inflight} | ${r.queued} | ${r.awaiting}${asksNote(r)} | ${r.paste} | ${r.blocked} |`);
  return [...out, '',
    `**Agents:** ${inflight.length} in flight on the ledger (the live agent roster is shown in each reply's footer)`, '',
    sessionText(footer.session), ''];
}

// ── page ────────────────────────────────────────────────────────────────────

/** Free text outside any wrap (ask context, the plain lists), so only what could open a link or autolink is escaped (backslash first-class, so `\[` cannot cancel the escape); everything else reads as typed. */
const escLinkChars = (s: string): string => s.replace(/[\\[\]<>]/g, '\\$&');
const li = (a: Item): string => `- \`${a.id}\` ${escLinkChars(oneLine(a.text, 200))}`;

/** The whole page. */
export function renderPage(input: PageInput): { page: string; date: string } {
  const { now, status, triage, prs, prData, ticketMap, priorities, config: cfg, command, start, startFailure } = input;
  const tickets = new Map<string, string>();
  for (const [t, list] of Object.entries(ticketMap)) for (const id of list) tickets.set(id, t);
  const meta = new Map(triage.items.map((i) => [i.id, i]));
  const asks: Item[] = status.awaiting.map((a) => ({ ...a, ticket: a.ticket ?? meta.get(a.id)?.ticket }));
  const blocked: Item[] = status.blocked.map((b) => ({ ...b, gate: meta.get(b.id)?.gate }));
  const deferred = triage.items.filter((i) => i.deferredUntil);
  const prPriorityStreams = priorities.state === 'ok' ? priorities.items.map((p) => p.stream) : [];
  const streams = streamOrder(cfg, [...asks.map((a) => a.stream), ...status.inflight.map((i) => i.stream), ...status.queued.map((i) => i.stream), ...prs.map((p) => p.stream), ...prPriorityStreams]);
  const t = zonedParts(now, cfg.tz);
  const age = (i: Item): string => ageLabel(i.ts, now);
  const withAge = (i: Item, extra: string): string => `${li(i)}${extra} · ${age(i) || 'age unknown'}`;
  const doneAt = (i: Item): string => (i.ts && Number.isFinite(Date.parse(i.ts)) ? ` · ${clockLabel(new Date(i.ts), cfg.tz)}` : '');
  const section = (title: string, rows: string[]): string[] => [`### ${title} (${rows.length})`, '', ...(rows.length ? rows : ['None.']), ''];

  const page = [
    '---', 'type: status', `updated: ${t.iso}`, '---', '',
    '# The Podium', '',
    `Updated ${clockLabel(now, cfg.tz)} · PR data ${prData.fetchedAt ? prDataLabel(prData.fetchedAt, now, cfg.tz) : 'unavailable'} (${t.date}). Regenerated by \`${command}\`.`, '',
    ...prWarning(prData, now, cfg.tz),
    ...(start ? startLines(start, now) : startFailure ? ['## Start here', '', `Start view unavailable (${startFailure}). Run \`journal.ts start-here\`.`, ''] : []),
    ...prioritiesSection(cfg, priorities, asks, status.inflight, prs, streams),
    ...workingSection(cfg, status.inflight, tickets, streams, now),
    ...queuedSection(cfg, status.queued, tickets, streams, now),
    ...asksSection(cfg, asks, prs, tickets, streams, t.date),
    ...prSection(cfg, prs, streams),
    '## Other status and findings', '',
    ...section('In flight', status.inflight.map((i) => withAge(i, ` [${i.stream ?? OTHER}]`))),
    ...section('Blocked', blocked.map((b) => withAge(b, ` (gate: ${b.gate ? escLinkChars(plain(b.gate)) : 'none recorded'})`))),
    ...section('Recent done', status.done.map((d) => `${li(d)}${doneAt(d)}`)),
    ...section('Deferred', deferred.map((d) => `${li(d)} (until ${d.deferredUntil})`)),
    ...statusSection(status.footer, status.inflight),
  ].join('\n');
  return { page, date: t.date };
}
