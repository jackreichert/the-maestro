/**
 * What's next: one ranked queue of work that could be picked up now, from every open ticket (all projects) and a snapshot of
 * tracker issues. Pure: the caller gathers the inputs (`gather.ts`), this module never reads a file, the clock or a process.
 *
 * The score is a sum of named terms, each printed beside the item, so a pick can always be explained and argued with:
 *   priority   P0 40, P1 30, P2 20, P3 10, P4 0 (tracker names Highest..Lowest map onto the same scale)
 *   age        +1 for every 7 days since created, at most 10
 *   pin        a place in a project's rank file (`## Ranked`): +30 for the first, one less per place, never under +10
 *   goal       +20 when today's priorities or this week's goals name the ticket or its tracker key; +10 when they name its project as a stream
 *   readiness  +10 with a filled `## What done looks like` section, -10 without one
 *   open PR    -15: the work is already in review
 *
 * Never offered (and listed with the reason when asked): closed, frozen by label (read-only, never offered as work), in progress,
 * blocked (status or an open blocked-by), in the rank file's `## Blocked on <user>` section, a blocked label, an open question on
 * the ledger naming it, or in flight on the ledger.
 */
import type { Ticket } from '../vault/tickets.ts';

export interface TrackerItem {
  key: string; title: string; status: string; priority: string; labels: string[];
  created?: string; updated?: string; url?: string;
  /** True when the issue's description has a "What done looks like" section. */
  doneLooksLike?: boolean;
}
export interface TrackerSnapshot { fetchedAt: string; source: string; items: TrackerItem[] }
/** A project's rank file: ticket ids in the order of `## Ranked`, and those under a `## Blocked on ...` heading. */
export interface RankFile { ranked: string[]; blocked: string[] }
/** An open ledger item, reduced to what matching needs. */
export interface LedgerRef { id: string; text: string; ticket?: string }
export interface PrRef { number: number; repo: string; title: string; branch: string; url: string }
export interface Goal { text: string; stream?: string }

export interface RankInput {
  tickets: Ticket[];
  tracker: TrackerSnapshot | null;
  rankFiles: Record<string, RankFile>;
  goals: Goal[];
  prs: PrRef[];
  inFlight: LedgerRef[];
  asks: LedgerRef[];
  frozenLabels: string[];
  blockedLabels: string[];
  now: Date;
}

export interface Term { name: 'priority' | 'age' | 'pin' | 'goal' | 'readiness' | 'pr'; points: number; why: string }
export interface Candidate {
  id: string; key?: string; title: string; project: string; source: 'ticket' | 'tracker' | 'both';
  priority: number; score: number; terms: Term[]; path?: string; url?: string;
}
export interface Excluded { id: string; key?: string; title: string; project: string; reason: string }
export interface Ranking { ranked: Candidate[]; excluded: Excluded[]; trackerFetchedAt: string | null }

export const PRIORITY_POINTS = [40, 30, 20, 10, 0] as const;
export const AGE_CAP = 10;
export const PIN_TOP = 30;
export const PIN_FLOOR = 10;
export const GOAL_NAMED = 20;
export const GOAL_STREAM = 10;
export const READY = 10;
export const OPEN_PR = -15;
const DAY_MS = 86_400_000;

const TRACKER_PRIORITY: Record<string, number> = { highest: 0, blocker: 0, critical: 0, high: 1, major: 1, medium: 2, normal: 2, low: 3, minor: 3, lowest: 4, trivial: 4 };
const CLOSED_STATES = new Set(['closed', 'done', 'resolved', 'released', 'cancelled', 'canceled', "won't do", 'wont do', "won't fix", 'duplicate', 'dropped']);
const ACTIVE_STATES = new Set(['in-progress', 'in progress', 'in review', 'code review', 'review', 'in staging', 'in qa', 'qa', 'testing', 'in development']);

/** A tracker priority name (`High`), `P1` or `1` on the 0..4 scale; unknown is 3, the ticket default. */
export function trackerPriority(raw: string): number {
  const v = raw.trim().toLowerCase();
  const n = /^p?([0-4])$/.exec(v);
  if (n) return Number(n[1]);
  return TRACKER_PRIORITY[v] ?? 3;
}

const stateOf = (status: string): 'closed' | 'active' | 'blocked' | 'open' => {
  const s = status.trim().toLowerCase();
  if (CLOSED_STATES.has(s)) return 'closed';
  if (s === 'blocked') return 'blocked';
  if (ACTIVE_STATES.has(s)) return 'active';
  return 'open';
};

/** The tracker key inside a ticket's `external` field (`jira-AB-12` -> `AB-12`), or undefined. */
export function externalKey(external: string | undefined): string | undefined {
  return external ? /([A-Z][A-Z0-9]+-\d+)$/.exec(external.trim())?.[1] : undefined;
}

/** True when a body has a `## What done looks like` section with something in it other than a placeholder. */
export function hasDoneSection(body: string): boolean {
  const m = /^## What done looks like[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  if (!m) return false;
  return (m[1] as string).replace(/_?TBD_?/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` names `id` as a whole token (letters and digits on either side do not count as a boundary). */
export const names = (text: string, id: string): boolean => !!id && new RegExp(`(^|[^A-Za-z0-9])${escapeRe(id)}($|[^A-Za-z0-9])`, 'i').test(text);

/** A rank file's ids: `[[id]]` links under `## Ranked` (in order, first place wins), and under any `## Blocked on ...` heading. */
export function parseRankFile(text: string): RankFile {
  const ranked: string[] = [];
  const blocked: string[] = [];
  let section: 'ranked' | 'blocked' | null = null;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { const t = (h[1] as string).toLowerCase(); section = t === 'ranked' ? 'ranked' : t.startsWith('blocked on') ? 'blocked' : null; continue; }
    if (!section) continue;
    for (const m of line.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const id = (m[1] as string).trim();
      const into = section === 'ranked' ? ranked : blocked;
      if (id && !into.includes(id)) into.push(id);
    }
  }
  return { ranked, blocked };
}

interface Work {
  id: string; key?: string; title: string; project: string; source: Candidate['source'];
  priority: number; labels: string[]; states: ReturnType<typeof stateOf>[]; blockedBy: string[];
  created?: string; ready: boolean; path?: string; url?: string;
}

const fromTicket = (t: Ticket, key: string | undefined): Work => ({
  id: t.id, ...(key ? { key } : {}), title: t.title, project: t.project, source: 'ticket', priority: t.priority, labels: t.labels,
  states: [t.archived ? 'closed' : stateOf(t.status)], blockedBy: t.blockedBy, ...(t.created ? { created: t.created } : {}), ready: hasDoneSection(t.body), path: t.path,
});

const fromTracker = (i: TrackerItem): Work => ({
  id: i.key, key: i.key, title: i.title, project: i.key.split('-')[0] as string, source: 'tracker', priority: trackerPriority(i.priority), labels: i.labels,
  states: [stateOf(i.status)], blockedBy: [], ...(i.created ? { created: i.created } : {}), ready: !!i.doneLooksLike, ...(i.url ? { url: i.url } : {}),
});

/** A ticket and the tracker issue it mirrors as one item: the higher priority, every label and state, the earlier creation. */
function merge(w: Work, i: TrackerItem): Work {
  const t = fromTracker(i);
  const created = [w.created, t.created].filter((d): d is string => !!d && Number.isFinite(Date.parse(d))).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return { ...w, source: 'both', priority: Math.min(w.priority, t.priority), labels: [...new Set([...w.labels, ...t.labels])], states: [...w.states, ...t.states], ready: w.ready || t.ready, ...(created ? { created } : {}), ...(t.url ? { url: t.url } : {}) };
}

/** The work items: every ticket, merged with the tracker issue its `external` names, plus tracker issues no ticket mirrors. */
function workItems(input: RankInput): Work[] {
  const byKey = new Map((input.tracker?.items ?? []).map((i) => [i.key.toUpperCase(), i]));
  const used = new Set<string>();
  const out = input.tickets.map((t) => {
    const key = externalKey(t.external);
    const hit = key ? byKey.get(key.toUpperCase()) : undefined;
    if (!hit || !key) return fromTicket(t, key);
    used.add(key.toUpperCase());
    return merge(fromTicket(t, key), hit);
  });
  for (const [k, i] of byKey) if (!used.has(k)) out.push(fromTracker(i));
  return out;
}

const tokens = (w: Work): string[] => [w.id, ...(w.key && w.key !== w.id ? [w.key] : [])];
const mentions = (w: Work, refs: LedgerRef[]): LedgerRef | undefined => refs.find((r) => tokens(w).some((t) => (r.ticket ?? '').toLowerCase() === t.toLowerCase() || names(r.text, t)));
const lower = (xs: string[]): Set<string> => new Set(xs.map((x) => x.toLowerCase()));

/** Why `w` is not offered, or null when it is a candidate. The first reason that applies is the one given. */
function exclusion(w: Work, input: RankInput, openIds: Set<string>): string | null {
  const frozen = lower(input.frozenLabels);
  const blockedLabels = lower(input.blockedLabels);
  if (w.states.includes('closed')) return 'closed';
  const f = w.labels.find((l) => frozen.has(l.toLowerCase()));
  if (f) return `frozen (label ${f}): read-only, never offered as work`;
  if (w.states.includes('active')) return 'in progress';
  if (w.states.includes('blocked')) return 'blocked (status)';
  const by = w.blockedBy.filter((b) => openIds.has(b));
  if (by.length) return `blocked by ${by.join(', ')}`;
  if (input.rankFiles[w.project]?.blocked.includes(w.id)) return 'waiting on the user (rank file)';
  const bl = w.labels.find((l) => blockedLabels.has(l.toLowerCase()));
  if (bl) return `waiting on the user (label ${bl})`;
  const ask = mentions(w, input.asks);
  if (ask) return `open question ${ask.id} names it`;
  const flight = mentions(w, input.inFlight);
  if (flight) return `in flight (${flight.id})`;
  return null;
}

const ageDays = (created: string | undefined, now: Date): number | null => {
  const t = created ? Date.parse(created) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null;
};

function terms(w: Work, input: RankInput): Term[] {
  const out: Term[] = [{ name: 'priority', points: PRIORITY_POINTS[Math.max(0, Math.min(4, w.priority))] as number, why: `P${w.priority}` }];
  const days = ageDays(w.created, input.now);
  if (days !== null && days >= 7) out.push({ name: 'age', points: Math.min(AGE_CAP, Math.floor(days / 7)), why: `${Math.floor(days / 7)}w old` });
  const place = input.rankFiles[w.project]?.ranked.indexOf(w.id) ?? -1;
  if (place >= 0) out.push({ name: 'pin', points: Math.max(PIN_FLOOR, PIN_TOP - place), why: `ranked #${place + 1}` });
  const named = input.goals.find((g) => tokens(w).some((t) => names(g.text, t)));
  const stream = input.goals.find((g) => g.stream && g.stream.toLowerCase() === w.project.toLowerCase());
  if (named) out.push({ name: 'goal', points: GOAL_NAMED, why: 'named in a goal' });
  else if (stream) out.push({ name: 'goal', points: GOAL_STREAM, why: `goal stream ${stream.stream}` });
  out.push(w.ready ? { name: 'readiness', points: READY, why: 'done defined' } : { name: 'readiness', points: -READY, why: 'no done section' });
  const pr = input.prs.find((p) => tokens(w).some((t) => names(p.title, t) || names(p.branch, t)));
  if (pr) out.push({ name: 'pr', points: OPEN_PR, why: `PR #${pr.number} open` });
  return out;
}

/** Every work item, ranked or excluded. Ties go to the higher priority, then the id. */
export function rankNext(input: RankInput): Ranking {
  const items = workItems(input);
  const openIds = new Set(items.filter((w) => !w.states.includes('closed')).map((w) => w.id));
  const ranked: Candidate[] = [];
  const excluded: Excluded[] = [];
  for (const w of items) {
    const why = exclusion(w, input, openIds);
    const base = { id: w.id, ...(w.key && w.key !== w.id ? { key: w.key } : {}), title: w.title, project: w.project };
    if (why) { if (why !== 'closed') excluded.push({ ...base, reason: why }); continue; }
    const ts = terms(w, input);
    ranked.push({ ...base, source: w.source, priority: w.priority, score: ts.reduce((n, t) => n + t.points, 0), terms: ts, ...(w.path ? { path: w.path } : {}), ...(w.url ? { url: w.url } : {}) });
  }
  ranked.sort((a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id));
  excluded.sort((a, b) => a.reason.localeCompare(b.reason) || a.id.localeCompare(b.id));
  return { ranked, excluded, trackerFetchedAt: input.tracker?.fetchedAt ?? null };
}

const oneLine = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const signed = (n: number): string => (n < 0 ? `${n}` : `+${n}`);

/** One line for a candidate: place, id (and tracker key), score, title, then every term with its points. */
export function candidateLine(c: Candidate, place: number): string {
  const why = c.terms.map((t) => `${t.why} ${signed(t.points)}`).join(', ');
  return `${place}. ${c.id}${c.key ? ` (${c.key})` : ''} · ${c.score} · ${oneLine(c.title, 90)} [${c.project}] · ${why}`;
}

/** The text `journal.ts next` prints: the top `top`, and with `all` the excluded ones and why. */
export function nextLines(r: Ranking, opts: { top: number; all?: boolean; trackerAgeNote?: string }): string[] {
  const shown = r.ranked.slice(0, opts.top);
  const head = `What's next (${shown.length} of ${r.ranked.length} ready${r.excluded.length ? `, ${r.excluded.length} held back` : ''})`;
  const lines = [head, ...(shown.length ? shown.map((c, i) => candidateLine(c, i + 1)) : ['Nothing ready: every open item is blocked, in flight or waiting on the user. `journal.ts next --all` says why.'])];
  if (opts.trackerAgeNote) lines.push(opts.trackerAgeNote);
  if (opts.all && r.excluded.length) lines.push('', 'Held back:', ...r.excluded.map((e) => `- ${e.id}${e.key ? ` (${e.key})` : ''} [${e.project}] ${oneLine(e.title, 70)} · ${e.reason}`));
  return lines;
}
