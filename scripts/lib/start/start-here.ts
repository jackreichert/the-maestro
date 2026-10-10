/**
 * The Start-here view: the one page a fresh reader needs first. A pure reducer from the board (a `Groups` fold of the ledger) plus
 * the week goals, priorities, standing lines and per-stream note counts, to a JSON-able `StartHere`, and a renderer to at most
 * 80 lines of text. `journal.ts start-here` prints the text (no server needed), `--json` prints the data, and the Podium page
 * embeds the same lines, so the renderings cannot disagree. Nothing here reads a file, the clock or a process.
 */
import { askBits } from '../journal/ask-fields.ts';
import { clip } from '../journal/format.ts';
import type { Groups } from '../journal/board.ts';
import type { LedgerItem } from '../ledger-core.ts';
import { PRIORITIES_UNSET_LINE, localDate } from '../status-page/priorities.ts';
import type { PrioritiesState } from '../status-page/priorities.ts';
import { weekLines } from '../status-page/week.ts';
import type { WeekState } from '../status-page/week.ts';
import type { StreamHome } from '../home/types.ts';

export const START_MAX_LINES = 80;
const OTHER = 'other';
const NEEDS_TOP = 5;

/** What a stream's tab holds, as counts; the notes themselves live on the tab. `unreadable` is set when the notes could not be read, so the stream is reported rather than omitted. */
export interface HomeCounts { context: boolean; decisions: boolean; plans: number; research: number; reviews: number; runbooks: number; epics: number; prs: number; unreadable?: string }
export interface NeedRow { id: string; stream: string; text: string; ageDays: number | null; stakes: string }
export interface FlightRow { id: string; stream: string; text: string; model?: string; since?: string; ticket?: string }
export interface DoneRow { stream: string; count: number; items: { id: string; text: string }[] }
export interface AnsweredRow { id: string; stream: string; asked: string; answer: string; date: string }

export interface StartHere {
  day: string; yesterday: string;
  week: WeekState; priorities: PrioritiesState;
  needs: { total: number; byStream: Record<string, number>; top: NeedRow[] };
  conditions: string[]; standing: string[];
  inFlight: FlightRow[]; queued: Record<string, number>;
  blocked: (FlightRow & { gate?: string })[];
  done: DoneRow[]; answered: AnsweredRow[];
  /** Null when no vault root is set: the notes were not read, which is not the same as none. A key with `unreadable` set could not be read and is still listed. */
  where: Record<string, HomeCounts> | null;
  /** Null when the check did not run. `unchecked` is projects that could not be read, so `total` may be short. */
  unreachableNotes: UnreachableNotes | null;
}

/** Unreachable notes for the start view: a count, not the note list. */
export interface UnreachableNotes { total: number; byStream: Record<string, number>; unchecked?: number }

export interface StartOptions { day: string; week: WeekState; priorities: PrioritiesState; conditions: string[]; standing: string[]; where: Record<string, HomeCounts> | null; now: Date; unreachableNotes?: UnreachableNotes | null }

const streamOf = (i: { stream?: string }): string => i.stream || OTHER;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const shift = (day: string, by: number): string => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + by); return d.toISOString().slice(0, 10); };

/** The working day before `day`: Friday for a Monday, a Sunday or a Saturday. */
export function previousWorkingDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return shift(day, dow === 1 ? -3 : dow === 0 ? -2 : -1);
}

/** The day the view is for: the local calendar day in `tz`, never the UTC date of `now`. */
export function viewDay(now: Date, tz: string): string {
  return localDate(now, tz);
}

const EMPTY_COUNTS = { context: false, decisions: false, plans: 0, research: 0, reviews: 0, runbooks: 0, epics: 0, prs: 0 };

/** Counts for a stream whose notes could not be read. The reason is one line, so the view can name the stream instead of dropping it. */
export function unreadableHome(reason: string): HomeCounts {
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  return { ...EMPTY_COUNTS, unreadable: why || 'unreadable' };
}

/** What a stream's home base holds, as counts. */
export function homeCounts(home: StreamHome): HomeCounts {
  const docs = home.links.find((l) => l.group === 'docs')?.items ?? [];
  const folder = (name: string): number => docs.filter((d) => (d.meta ?? '').startsWith(name)).length;
  const group = (g: string): number => home.links.find((l) => l.group === g)?.items.length ?? 0;
  return { context: folder('CONTEXT') > 0, decisions: folder('DECISIONS') > 0, plans: folder('Plans'), research: folder('Research'), reviews: folder('Reviews'), runbooks: group('runbooks'), epics: home.epics.length, prs: group('prs') };
}

const ageDays = (ts: string | undefined, now: Date): number | null => (ts && Number.isFinite(Date.parse(ts)) ? Math.max(0, Math.floor((now.getTime() - Date.parse(ts)) / 86_400_000)) : null);
const flight = (i: LedgerItem): FlightRow => ({ id: i.id ?? '', stream: streamOf(i), text: i.text ?? '', ...(i.model ? { model: i.model } : {}), ...(typeof i.stateTs === 'string' || i.ts ? { since: (i.stateTs as string | undefined) ?? i.ts } : {}), ...(i.ticket ? { ticket: i.ticket } : {}) });

/** The board as the Start view's data. Asks rank: by the position of their stream in today's priorities (streams not named last), then older before newer. */
export function buildStart(g: Groups, o: StartOptions): StartHere {
  const asks = [...g.awaiting, ...g.paste];
  const priorityStreams = o.priorities.state === 'ok' ? o.priorities.items.flatMap((p) => (p.stream ? [p.stream] : [])) : [];
  const urgent = (i: LedgerItem): number => { const at = priorityStreams.findIndex((s) => same(s, streamOf(i))); return at === -1 ? priorityStreams.length : at; };
  const ranked = [...asks].sort((a, b) => urgent(a) - urgent(b) || (a.ts ?? '').localeCompare(b.ts ?? ''));
  const byStream: Record<string, number> = {};
  for (const a of asks) byStream[streamOf(a)] = (byStream[streamOf(a)] ?? 0) + 1;
  const yesterday = previousWorkingDay(o.day);
  const doneRows = g.doneOn(yesterday);
  const doneStreams = [...new Set(doneRows.map(streamOf))];
  const answered = [o.day, shift(o.day, -1), shift(o.day, -2)].flatMap((d) => g.decidedOn(d));
  const queued: Record<string, number> = {};
  for (const q of g.queued) queued[streamOf(q)] = (queued[streamOf(q)] ?? 0) + 1;
  return {
    day: o.day, yesterday, week: o.week, priorities: o.priorities,
    needs: { total: asks.length, byStream, top: ranked.map((a): NeedRow => ({ id: a.id ?? '', stream: streamOf(a), text: a.text ?? '', ageDays: ageDays(a.ts, o.now), stakes: askBits(a, 80).join(' · ') })) },
    conditions: o.conditions, standing: o.standing,
    inFlight: g.inflight.map(flight).sort((a, b) => a.stream.localeCompare(b.stream)), queued,
    blocked: g.blocked.map((b) => ({ ...flight(b), ...(b.gate ? { gate: b.gate } : {}) })),
    done: doneStreams.map((s) => { const rows = doneRows.filter((d) => streamOf(d) === s); return { stream: s, count: rows.length, items: rows.map((d) => ({ id: d.id ?? '', text: d.text ?? '' })) }; }),
    answered: answered.map((a) => ({ id: a.id ?? '', stream: streamOf(a), asked: a.text ?? '', answer: a.closedBy?.text ?? '', date: a.closedBy?.date ?? '' })),
    where: o.where,
    unreachableNotes: o.unreachableNotes ?? null,
  };
}

/** One line for the start view. A missing check is not the same as zero. */
export function unreachableLine(n: UnreachableNotes | null, stream?: string): string {
  if (!n) return 'Unreachable notes: not checked.';
  if (stream) {
    const hit = Object.entries(n.byStream).find(([k]) => same(k, stream));
    return `Unreachable notes: ${hit ? hit[1] : 0} in ${stream}. journal.ts notes-check lists them.`;
  }
  const by = Object.entries(n.byStream).filter(([, c]) => c > 0).map(([k, c]) => `${k} ${c}`).join(', ');
  const gap = n.unchecked ? ` ${n.unchecked} project${n.unchecked === 1 ? '' : 's'} could not be checked.` : '';
  if (!n.total && !n.unchecked) return 'Unreachable notes: 0.';
  return `Unreachable notes: ${n.total}${by ? ` (${by})` : ''}.${gap} journal.ts notes-check lists them.`;
}

interface Section { title: string; rows: string[]; more: string; cap?: number }
const one = (s: string, n: number): string => clip(s.replace(/\s+/g, ' ').replace(/(?:[a-z][a-z0-9+.-]*:\/\/|obsidian:)\S*/gi, '').trim(), n);
const ago = (iso: string | undefined, now: Date): string => { const d = ageDays(iso, now); return d === null ? '' : d === 0 ? ' · today' : ` · ${d}d`; };
const tag = (stream: string): string => (stream === OTHER ? '' : ` [${stream}]`);

function whereLine(stream: string, c: HomeCounts): string {
  if (c.unreadable) return `- ${stream}: notes could not be read (${one(c.unreadable, 120)})`;
  const parts = [c.context ? 'CONTEXT' : 'no CONTEXT', c.decisions ? 'DECISIONS' : '', c.epics ? `${c.epics} epic${c.epics === 1 ? '' : 's'}` : '', c.plans ? `${c.plans} plans` : '', c.runbooks ? `${c.runbooks} runbooks` : '', c.research ? `${c.research} research` : '', c.reviews ? `${c.reviews} reviews` : '', c.prs ? `${c.prs} PRs` : ''];
  return `- ${stream}: ${parts.filter(Boolean).join(' · ')}`;
}

/** The sections for `s`, narrowed to one stream when `stream` is given. */
function sections(s: StartHere, now: Date, stream?: string): Section[] {
  const mine = <T extends { stream: string }>(rows: T[]): T[] => (stream ? rows.filter((r) => same(r.stream, stream)) : rows);
  const week = s.week.state === 'ok' ? weekLines(s.week).slice(1) : weekLines(s.week);
  const pr = s.priorities.state === 'ok' ? s.priorities.items.map((p, i) => `${i + 1}. ${p.text}${p.stream ? ` [${p.stream}]` : ''}`) : [PRIORITIES_UNSET_LINE];
  const needs = mine(s.needs.top);
  const total = stream ? needs.length : s.needs.total;
  const counts = Object.entries(s.needs.byStream).map(([k, n]) => `${k} ${n}`).join(', ');
  const flight = mine(s.inFlight);
  const where = s.where === null ? ['Notes not read: vault_root is not set, so note counts are unknown.'] : Object.entries(s.where).filter(([k]) => !stream || same(k, stream)).map(([k, c]) => whereLine(k, c));
  const queued = Object.entries(s.queued).filter(([k]) => !stream || same(k, stream));
  return [
    { title: 'This week', rows: stream ? [] : week, more: 'journal.ts week show' },
    { title: stream ? `Today's priorities for ${stream}` : 'Priorities today, in order', rows: stream ? pr.filter((l) => l.toLowerCase().includes(`[${stream.toLowerCase()}]`)) : pr, more: 'journal.ts priorities show' },
    { title: `Needs Jack (${total}${!stream && counts ? `: ${counts}` : ''})`, rows: needs.map((n) => `- \`${n.id}\`${tag(n.stream)} ${one(n.text, 130)}${n.ageDays === null ? '' : ` · ${n.ageDays}d`} · ${n.stakes || 'no decision fields'}`), more: 'journal.ts status', cap: stream ? 10 : NEEDS_TOP },
    { title: 'Commitments and conditions', rows: [...s.conditions, ...s.standing].map((l) => `- ${one(l, 200)}`), more: 'journal.ts standing list', cap: 6 },
    { title: `In flight (${flight.length}${queued.length ? `, queued ${queued.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''})`, rows: flight.map((f) => `- \`${f.id}\`${tag(f.stream)} ${one(f.text, 100)}${f.model ? ` · ${f.model}` : ''}${ago(f.since, now)}`), more: 'journal.ts status', cap: 10 },
    { title: 'Blocked', rows: mine(s.blocked).map((b) => `- \`${b.id}\`${tag(b.stream)} ${one(b.text, 100)}${b.gate ? ` · gate: ${one(b.gate, 60)}` : ''}`), more: 'journal.ts triage', cap: 4 },
    { title: `Yesterday (${s.yesterday})`, rows: mine(s.done).map((d) => `- ${d.stream}: ${d.count} done, ${d.items.slice(0, 3).map((x) => one(x.text, 60)).join('; ')}${d.items.length > 3 ? '; …' : ''}`), more: 'journal.ts standup', cap: 6 },
    { title: 'Answered in the last 2 days', rows: mine(s.answered).map((a) => `- \`${a.id}\`${tag(a.stream)} ${one(a.asked, 70)} → ${one(a.answer || '(no answer text)', 90)}`), more: 'journal.ts triage', cap: 6 },
    { title: 'Where things live', rows: where, more: 'the stream tabs' },
  ];
}

/** At most `max` lines: titles and the opening line of each section always stay, the longest section gives up rows first. */
export function startLines(s: StartHere, now: Date, opts: { stream?: string; max?: number } = {}): string[] {
  const max = opts.max ?? START_MAX_LINES;
  const secs = sections(s, now, opts.stream).filter((x) => x.rows.length || x.title.startsWith('Needs') || x.title.startsWith('In flight'));
  const shown = secs.map((x) => Math.min(x.rows.length, x.cap ?? x.rows.length));
  const head = [opts.stream ? `## Start here: ${opts.stream}` : '## Start here', '',
    `${s.day}. Read this first; each block names where the full version is. Per stream: \`journal.ts start-here --stream <Stream>\`.`,
    unreachableLine(s.unreachableNotes, opts.stream), ''];
  const size = (): number => head.length + secs.reduce((n, x, k) => n + 2 + shown[k]! + (shown[k]! < x.rows.length ? 1 : 0), 0);
  while (size() > max) {
    const k = shown.reduce((best, n, i) => (n > shown[best]! ? i : best), 0);
    if (shown[k]! <= 1) break;
    shown[k]!--;
  }
  const body = secs.flatMap((x, k) => [`### ${x.title}`, ...(x.rows.length ? x.rows.slice(0, shown[k]) : ['None.']), ...(shown[k]! < x.rows.length ? [`… +${x.rows.length - shown[k]!} more: ${x.more}`] : []), '']);
  return [...head, ...body].slice(0, max);
}
