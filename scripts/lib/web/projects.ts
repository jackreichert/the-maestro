/**
 * `GET /api/projects`: Home's one status row per stream, its important links, and done per week. Read-only. The disk reads are
 * `readBoard` (ledger, PR cache, priorities), the optional `stream-homes.json`, and the guarded vault reader, which may open only a
 * project's CONTEXT.md and INDEX.md. `projectsData` is the pure part: tests call it with a fixed clock and a fake note reader.
 */
import { createReader } from '../vault/reader.ts';
import { DOC_FILE_SCOPES } from '../home/docs.ts';
import { readHomes } from '../home/config.ts';
import type { Homes } from '../home/config.ts';
import { slugOf } from '../home/mapping.ts';
import { obsidianUri } from '../status-page/links.ts';
import { readBoard } from './api.ts';
import type { WebConfig } from './api.ts';
import { throughputByDay } from './charts.ts';
import type { ThroughputDay } from './charts.ts';
import { buildState as reduceState } from './state.ts';
import type { PodiumState } from './state.ts';
import type { HomeLink, ProjectRow, ProjectStateWord, ProjectsData, WeekCount } from '../../web/client/src/types.ts';

/** Eight seven-day periods: enough to see a trend, short enough that every column is recent work. */
export const WEEKS = 8;
const DAY_MS = 86_400_000;
const NOTE_MAX_BYTES = 512 * 1024;
const STATUS_MAX = 160;
const INDEX_SCOPE = { name: 'library index', pattern: /^Projects\/[^/]+\/INDEX\.md$/ };

/** A vault note's text by vault-relative path, or null when it is missing or the reader refused it. */
export type ReadNote = (path: string) => string | null;
export interface ProjectsInput { state: PodiumState; throughput: ThroughputDay[]; homes: Homes; readNote: ReadNote; vaultName?: string; now: Date }

/** The rows, links and weekly counts for the board's streams (`other` left out: it is not a project). */
export function projectsData(inp: ProjectsInput): ProjectsData {
  const streams = inp.state.streams.filter((s) => s !== 'other');
  const projectsOf = (stream: string): string[] => {
    const listed = inp.homes.streams[stream]?.projects ?? [];
    if (listed.length) return listed;
    const guess = slugOf(stream);   // unconfigured: the folder named like the stream, claimed only when it has a note to show
    return guess && (inp.readNote(`Projects/${guess}/CONTEXT.md`) !== null || inp.readNote(`Projects/${guess}/INDEX.md`) !== null) ? [guess] : [];
  };
  const rows = streams.map((stream) => projectRow(inp, stream, projectsOf(stream)));
  return { generatedAt: inp.now.toISOString(), today: inp.state.today, rows, links: homeLinks(inp, rows), weeks: weekly(inp.throughput) };
}

function projectRow(inp: ProjectsInput, stream: string, projects: string[]): ProjectRow {
  const { state: st, now } = inp;
  const mine = <T extends { stream: string }>(xs: T[]): T[] => xs.filter((x) => x.stream === stream);
  const asks = mine(st.asks);
  const inflight = [...mine(st.working), ...mine(st.stale)];   // a stale row is still open, in flight work here
  const open = [...inflight, ...mine(st.blocked)];
  const ages = [...asks.map((a) => a.ageDays), ...open.flatMap((w) => (w.since && Number.isFinite(Date.parse(w.since)) ? [(now.getTime() - Date.parse(w.since)) / DAY_MS] : []))];
  const days = inp.throughput.filter((d) => (d.byStream[stream] ?? 0) > 0).map((d) => d.date);
  const shippedWeek = inp.throughput.slice(-7).reduce((t, d) => t + (d.byStream[stream] ?? 0), 0);
  const priorities = st.priorities.state === 'ok' ? st.priorities.items : [];
  const rankAt = priorities.findIndex((p) => p.stream === stream);
  const counts = { asks: asks.length, inflight: inflight.length, blocked: mine(st.blocked).length, prs: mine(st.prs).length };
  return {
    stream, projects, status: statusLine(inp.readNote, projects, rankAt === -1 ? undefined : priorities[rankAt]?.text), rank: rankAt === -1 ? null : rankAt + 1,
    ...counts, oldestOpenDays: ages.length ? Math.max(0, Math.floor(Math.max(...ages))) : null,
    lastShipped: days.at(-1) ?? null, shippedWeek, state: stateWord(counts, shippedWeek),
  };
}

/** The first rule that holds names the row: what needs the reader first, then what is stuck, then whether anything moves. */
const STATE_RULES: { word: ProjectStateWord; when: (c: { asks: number; blocked: number; inflight: number }, shipped: number) => boolean }[] = [
  { word: 'waiting on you', when: (c) => c.asks > 0 },
  { word: 'blocked', when: (c) => c.blocked > 0 },
  { word: 'moving', when: (c, shipped) => c.inflight > 0 || shipped > 0 },
];
export function stateWord(c: { asks: number; blocked: number; inflight: number }, shippedWeek: number): ProjectStateWord {
  return STATE_RULES.find((r) => r.when(c, shippedWeek))?.word ?? 'quiet';
}

/** The first line under `## Now` in the first project CONTEXT that has one, list marker and emphasis stripped; else the priority. */
function statusLine(readNote: ReadNote, projects: string[], priority: string | undefined): ProjectRow['status'] {
  for (const p of projects) {
    const text = nowLine(readNote(`Projects/${p}/CONTEXT.md`) ?? '');
    if (text) return { text, from: 'context' };
  }
  return priority ? { text: clip(priority), from: 'priority' } : null;
}

export function nowLine(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^##\s+Now\s*$/i.test(l.trim()));
  if (at === -1) return '';
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(l.trim())) return '';
    const text = l.trim().replace(/^([-*+]|\d+\.)\s+/, '').replace(/[*_`]/g, '').trim();
    if (text) return clip(text);
  }
  return '';
}

const clip = (s: string): string => (s.length > STATUS_MAX ? `${s.slice(0, STATUS_MAX - 1).trimEnd()}…` : s);

/** Each stream's pins, then each project's CONTEXT and library INDEX that exist. Note links need the vault name; without it they are left out. */
function homeLinks(inp: ProjectsInput, rows: ProjectRow[]): HomeLink[] {
  const note = (path: string): string | null => (inp.vaultName ? obsidianUri(inp.vaultName, path.replace(/\.md$/, '')) : null);
  const out: HomeLink[] = [];
  const add = (l: Omit<HomeLink, 'url'>, url: string | null): void => { if (url && !out.some((o) => o.url === url)) out.push({ ...l, url }); };
  for (const { stream, projects } of rows) {
    for (const pin of inp.homes.streams[stream]?.pins ?? []) add({ label: pin.label, kind: 'pin', stream }, 'url' in pin ? pin.url : note(pin.note));
    for (const p of projects) {
      if (inp.readNote(`Projects/${p}/CONTEXT.md`) !== null) add({ label: `${p} context`, kind: 'context', stream }, note(`Projects/${p}/CONTEXT.md`));
      if (inp.readNote(`Projects/${p}/INDEX.md`) !== null) add({ label: `${p} library`, kind: 'library', stream }, note(`Projects/${p}/INDEX.md`));
    }
  }
  return out;
}

/** Days (oldest first) folded into seven-day periods counted back from the last day, so the last period ends today. */
export function weekly(days: ThroughputDay[]): WeekCount[] {
  const out: WeekCount[] = [];
  for (let end = days.length; end > 0; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    const byStream: Record<string, number> = {};
    for (const d of chunk) for (const [s, n] of Object.entries(d.byStream)) byStream[s] = (byStream[s] ?? 0) + n;
    out.unshift({ start: chunk[0]?.date ?? '', total: chunk.reduce((t, d) => t + d.total, 0), byStream });
  }
  return out;
}

/** The whole payload from disk. With no vault root nothing is read from the vault: rows still come, with no project notes. */
export function buildProjects(cfg: WebConfig, now: Date = new Date()): ProjectsData {
  const { inputs, g } = readBoard(cfg, now);
  const state = reduceState(inputs);
  const reader = cfg.vaultRoot ? createReader({ root: cfg.vaultRoot, dirScopes: [], fileScopes: [...DOC_FILE_SCOPES, INDEX_SCOPE] }) : null;
  const cache = new Map<string, string | null>();
  const readNote: ReadNote = (path) => {
    if (!reader) return null;
    if (!cache.has(path)) { const r = reader.read(path, NOTE_MAX_BYTES); cache.set(path, r.ok ? r.text : null); }
    return cache.get(path) ?? null;
  };
  return projectsData({
    state, homes: readHomes(cfg.statusDir, state.streams), readNote, now, ...(cfg.page.vaultName ? { vaultName: cfg.page.vaultName } : {}),
    throughput: throughputByDay(g.items, WEEKS * 7, cfg.page.tz, now),
  });
}
