/**
 * Per-project priorities: one file per project per day, `<vault>/Projects/<project>/Status/priorities/YYYY-MM-DD.md`.
 * The container-wide `priorities.md` (priorities.ts) stays; this is the copy each project can read from its own folder, with
 * yesterday's list carried into today so a new day never starts from "not set".
 *
 * File shape (one line per item, no wraps):
 *   ---                      type, project, date, carried-from (a date or `none`), written-by (`priorities set` or `roll-maintenance`)
 *   ## Today                 `- text | Stream`, or the single line `- not set yet` when roll wrote it before the day's list was confirmed
 *   ## Carried from <date>   each earlier Today item, then ` · ` and its stream's status at carry time
 *   ## Next                  up to 5 queued ledger ids of the project's streams
 * Every text printed passes the secret scan (a hit becomes a marker, never the matched value). Names and dates that build a path are
 * validated first, so nothing can land outside `Projects/<project>/Status/priorities/`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fold, isOpen, isQueued } from '../ledger-core.ts';
import type { LedgerRow, RegistryLookup } from '../ledger-core.ts';
import { plainName } from '../home/config.ts';
import type { Homes } from '../home/config.ts';
import { createExclusive } from '../journal/handoff.ts';
import { safe } from '../cold-start.ts';
import type { ProjectEntry } from '../cold-start.ts';
import { parsePriority, ITEM_LINE } from './priorities.ts';
import type { Priority } from './priorities.ts';

export type WrittenBy = 'priorities set' | 'roll-maintenance';
export const NOT_SET_YET = 'not set yet';
export const NEXT_MAX = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export interface ProjectFile {
  project: string;
  date: string;
  /** The day the carry-over came from, or '' when there was none. */
  carriedFrom: string;
  writtenBy: WrittenBy;
  today: Priority[];
  /** Each carried item and its stream's status at carry time. */
  carried: { item: Priority; status: string }[];
  /** Queued ledger items of the project's streams: id and clipped text. */
  next: { id: string; text: string }[];
}

/** The project's folder for these files, built only from a validated name. Throws on a name that is not a plain project name. */
export function prioritiesDir(vault: string, project: string): string {
  if (!plainName(project)) throw new Error(`"${String(project).slice(0, 40)}" is not a project folder name`);
  return join(vault, 'Projects', project, 'Status', 'priorities');
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The projects a stream's priorities belong to: the stream's `projects` in stream-homes.json when it lists any; else every repo
 * `status_repo_streams` maps to the stream; else the container project. An item with no stream goes to the container project.
 * Names that are not plain project names are dropped.
 */
export function projectsFor(stream: string | undefined, homes: Homes, repoStreams: Record<string, string>, containerProject: string): string[] {
  const found = stream ? Object.entries(homes.streams).find(([name]) => sameName(name, stream))?.[1].projects ?? [] : [];
  const byRepo = stream ? Object.entries(repoStreams).filter(([, s]) => sameName(s, stream)).map(([repo]) => repo) : [];
  const named = (xs: string[]): string[] => [...new Set(xs.filter((p) => plainName(p)))];
  return [named(found), named(byRepo), named([containerProject])].find((xs) => xs.length) ?? [];
}

/** Splits a list across projects: each project gets the items whose stream maps to it, in the order given. */
export function fanOut(items: Priority[], map: (stream: string | undefined) => string[]): Map<string, Priority[]> {
  const out = new Map<string, Priority[]>();
  for (const item of items) for (const project of map(item.stream)) out.set(project, [...(out.get(project) ?? []), item]);
  return out;
}

/** A stream's work as `2 done, 1 in flight, 3 queued, 0 blocked`: done on `day`, and open now. */
export function streamStatus(rows: LedgerRow[], registry: RegistryLookup | null, stream: string | undefined, day: string): string {
  const f = fold(rows, registry);
  const mine = f.items.filter((i) => !f.hidden.has(i.id ?? '') && (stream ? sameName(i.stream ?? '', stream) : !i.stream));
  const done = mine.filter((i) => i.closedBy?.kind === 'done' && (i.closedBy.date ?? String(i.closedBy.ts ?? '').slice(0, 10)) === day).length;
  const open = mine.filter((i) => isOpen(i));
  const queued = open.filter(isQueued).length;
  const blocked = open.filter((i) => i.kind === 'blocked').length;
  const inFlight = open.filter((i) => i.kind === 'wip').length - queued;
  return `${done} done, ${inFlight} in flight, ${queued} queued, ${blocked} blocked`;
}

/** The queued items of the given streams as `Next` entries, oldest first, at most NEXT_MAX, each text through the secret scan. */
export function nextItems(rows: LedgerRow[], registry: RegistryLookup | null, streams: string[]): { id: string; text: string }[] {
  const f = fold(rows, registry);
  return f.items.filter((i) => !f.hidden.has(i.id ?? '') && isQueued(i) && streams.some((s) => sameName(s, i.stream ?? '')))
    .slice(0, NEXT_MAX).map((i) => ({ id: safe(i.id, 40) || '?', text: safe(i.text, 120) }));
}

/** The newest `YYYY-MM-DD.md` in `dir` strictly before `today` (so a Monday carries Friday's), or null. */
export function previousFile(dir: string, today: string): { date: string; path: string } | null {
  if (!existsSync(dir)) return null;
  const dates = readdirSync(dir).map((n) => n.match(DAY_FILE)?.[1]).filter((d): d is string => d !== undefined && d < today).sort();
  const date = dates[dates.length - 1];
  return date ? { date, path: join(dir, `${date}.md`) } : null;
}

/** The file text for `file`. Items and statuses are scanned and clipped; the shape is fixed. */
export function renderProjectFile(file: ProjectFile): string {
  const item = (p: Priority): string => `${safe(p.text, 200) || '?'}${p.stream ? ` | ${safe(p.stream, 40)}` : ''}`;
  const lines = [
    '---', 'type: priorities', `project: ${file.project}`, `date: ${file.date}`, `carried-from: ${file.carriedFrom || 'none'}`, `written-by: ${file.writtenBy}`, '---', '',
    '## Today', ...(file.today.length ? file.today.map((p) => `- ${item(p)}`) : [`- ${NOT_SET_YET}`]),
  ];
  if (file.carried.length) lines.push('', `## Carried from ${file.carriedFrom}`, ...file.carried.map((c) => `- ${item(c.item)} · ${safe(c.status, 80)}`));
  if (file.next.length) lines.push('', '## Next', ...file.next.map((n) => `- \`${safe(n.id, 40) || '?'}\` ${safe(n.text, 120)}`));
  return `${lines.join('\n')}\n`;
}

/** The sections of a project file by heading, and its `Today` items (the `not set yet` line is not an item). */
export function parseProjectFile(text: string): { date: string; carriedFrom: string; writtenBy: string; today: Priority[]; notSet: boolean; carriedCount: number; carried: ProjectFile['carried'] } {
  const front = (key: string): string => text.match(new RegExp(`^${key}: (\\S+)\\s*$`, 'm'))?.[1] ?? '';
  const sections = new Map<string, string[]>();
  let current = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { current = h[1] ?? ''; sections.set(current, []); } else if (current) sections.get(current)?.push(line);
  }
  const bodies = (name: string): string[] => [...sections.entries()].filter(([k]) => k === name || k.startsWith(`${name} `)).flatMap(([, v]) => v)
    .map((l) => l.match(ITEM_LINE)?.[5]).filter((b): b is string => b !== undefined);
  const today = bodies('Today');
  const date = front('date');
  const carriedFrom = front('carried-from');
  const carried = bodies('Carried from').map((b) => {
    const cut = b.lastIndexOf(' · ');
    return cut === -1 ? { item: parsePriority(b), status: '' } : { item: parsePriority(b.slice(0, cut)), status: b.slice(cut + 3).trim() };
  });
  return {
    writtenBy: text.match(/^written-by: (.+?)\s*$/m)?.[1] ?? '', carried,
    date: DATE.test(date) ? date : '', carriedFrom: DATE.test(carriedFrom) ? carriedFrom : '',
    today: today.filter((b) => b !== NOT_SET_YET).map(parsePriority), notSet: today.length === 1 && today[0] === NOT_SET_YET,
    carriedCount: bodies('Carried from').length,
  };
}

export type WriteResult = 'written' | 'exists' | 'no-project';

/**
 * Writes one day's file. A past day is never written. `roll-maintenance` never replaces a file that exists (create-exclusive, so a
 * list `priorities set` already wrote is safe); `priorities set` replaces today's file (temp file, then rename). A project with
 * no folder in the vault is not created from here: the result says `no-project` and nothing is written.
 */
export function writeProjectPriorities(vault: string, project: string, today: string, file: ProjectFile): WriteResult {
  if (!DATE.test(file.date) || !DATE.test(today)) throw new Error('date must be YYYY-MM-DD');
  if (file.date < today) throw new Error(`refusing to write ${file.date}: it is before today (${today})`);
  const dir = prioritiesDir(vault, project);
  if (!existsSync(join(vault, 'Projects', project)) || !statSync(join(vault, 'Projects', project)).isDirectory()) return 'no-project';
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${file.date}.md`);
  const body = renderProjectFile({ ...file, project });
  if (file.writtenBy === 'roll-maintenance') return createExclusive(path, body) ? 'written' : 'exists';
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return 'written';
}

/** The projects whose file for `day` has Today items, by name, whoever wrote it (`priorities set` or roll). A folder that is not a plain project name is ignored. */
export function projectsWithTodayOn(vault: string, day: string): string[] {
  const root = join(vault, 'Projects');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => plainName(name) && (readProjectFile(join(prioritiesDir(vault, name), `${day}.md`))?.today.length ?? 0) > 0);
}

/** Reads and parses a project file; null when it is missing or unreadable. */
export function readProjectFile(path: string): ReturnType<typeof parseProjectFile> | null {
  try { return parseProjectFile(readFileSync(path, 'utf8')); } catch { return null; }
}

export interface CarryInput {
  vault: string;
  today: string;
  rows: LedgerRow[];
  registry: RegistryLookup | null;
  homes: Homes;
  repoStreams: Record<string, string>;
  containerProject: string;
  /** The container-wide list as priorities.md holds it (its date and items), or null when there is no file. */
  container: { date: string; items: Priority[] } | null;
}

/**
 * Starts today's file for each project that had priorities before, written by roll: yesterday's Today items (the project's own previous
 * file plus the container list fanned out to it) become `Carried from <date>` with each stream's status, and Today says `not set yet`
 * until a person confirms. When the container list is already dated today, it is today's list. A project whose file for today exists
 * is left alone. Problems are per project and never stop the others.
 */
export function carryPriorities(input: CarryInput): { written: string[]; problems: string[] } {
  const { vault, today, rows, registry, homes, repoStreams, containerProject, container } = input;
  const streams = [...new Set([...Object.keys(homes.streams), ...Object.values(repoStreams)])];
  const route = (s: string | undefined): string[] => projectsFor(s, homes, repoStreams, containerProject);
  const candidates = [...new Set([containerProject, ...streams.flatMap((s) => route(s))])];
  const asToday = container?.date === today;
  const fanned = fanOut(container?.items ?? [], route);
  const written: string[] = [];
  const problems: string[] = [];
  for (const project of candidates) {
    try {
      const prev = previousFile(prioritiesDir(vault, project), today);
      const own = prev ? readProjectFile(prev.path) : null;
      const fromContainer = !asToday && container && container.date < today ? fanned.get(project) ?? [] : [];
      const items = [...(own?.today ?? []), ...fromContainer].filter((p, i, all) => all.findIndex((q) => q.text === p.text && q.stream === p.stream) === i);
      const todayItems = asToday ? fanned.get(project) ?? [] : [];
      if (!items.length && !todayItems.length) continue;
      const dates = [prev?.date, !asToday && container && container.date < today ? container.date : ''].filter((d): d is string => Boolean(d)).sort();
      const carriedFrom = dates[dates.length - 1] ?? '';
      const projectStreams = streams.filter((s) => route(s).includes(project));
      const result = writeProjectPriorities(vault, project, today, {
        project, date: today, carriedFrom, writtenBy: 'roll-maintenance', today: todayItems,
        carried: items.map((item) => ({ item, status: streamStatus(rows, registry, item.stream, carriedFrom || today) })),
        next: nextItems(rows, registry, projectStreams),
      });
      if (result === 'written') written.push(project);
      else if (result === 'no-project') problems.push(`${project}: no vault folder Projects/${project}`);
    } catch (e) {
      problems.push(`${project}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100)}`);
    }
  }
  return { written, problems };
}

const MAX_CONTEXT_BYTES = 256 * 1024;

/** The first `max` non-blank lines under `## <heading>` (to the next `## `), as written; null when the heading is missing. */
export function sectionLines(text: string, heading: string, max = 3): string[] | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const t = l.replace(/^\s*[-*]\s+/, '').trim();
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const dayFiles = (dir: string): { date: string; path: string }[] =>
  (existsSync(dir) ? readdirSync(dir) : []).map((n) => n.match(DAY_FILE)?.[1]).filter((d): d is string => d !== undefined).sort().reverse().map((date) => ({ date, path: join(dir, `${date}.md`) }));

/** One project as the cold-start page prints it: CONTEXT.md's Now and Next, and the newest two priorities files. Vault-relative paths only. Read-only; an unreadable file reads as missing. */
export function readProjectEntry(vault: string, project: string, streams: string[]): ProjectEntry {
  const contextPath = join('Projects', project, 'CONTEXT.md');
  let context: string | null = null;
  try { if (statSync(join(vault, contextPath)).size <= MAX_CONTEXT_BYTES) context = readFileSync(join(vault, contextPath), 'utf8'); } catch { /* no CONTEXT.md */ }
  const files = dayFiles(prioritiesDir(vault, project));
  const rel = (f: { date: string }): string => join('Projects', project, 'Status', 'priorities', `${f.date}.md`);
  const newest = files[0];
  const parsed = newest ? readProjectFile(newest.path) : null;
  return {
    project, streams, contextPath,
    now: context === null ? null : sectionLines(context, 'Now'), next: context === null ? null : sectionLines(context, 'Next'),
    priorities: newest ? { date: newest.date, path: rel(newest), today: parsed?.today.length ?? 0, carried: parsed?.carriedCount ?? 0 } : null,
    previous: files[1] ? { date: files[1].date, path: rel(files[1]) } : null,
  };
}

/** The projects of the streams with something open, most open first (then by name), each read with `readProjectEntry`. The page shows the first few. */
export function activeProjects(input: Omit<CarryInput, 'today' | 'container'>): ProjectEntry[] {
  const { vault, rows, registry, homes, repoStreams, containerProject } = input;
  const f = fold(rows, registry);
  const perStream = new Map<string, number>();
  for (const i of f.items) if (isOpen(i) && !f.hidden.has(i.id ?? '') && i.kind !== 'question' && i.kind !== 'decision') perStream.set(i.stream ?? '', (perStream.get(i.stream ?? '') ?? 0) + 1);
  const perProject = new Map<string, { open: number; streams: string[] }>();
  for (const [stream, count] of perStream) {
    for (const project of projectsFor(stream || undefined, homes, repoStreams, containerProject)) {
      const entry = perProject.get(project) ?? { open: 0, streams: [] };
      entry.open += count;
      if (stream && !entry.streams.includes(stream)) entry.streams.push(stream);
      perProject.set(project, entry);
    }
  }
  return [...perProject.entries()].sort((a, b) => b[1].open - a[1].open || a[0].localeCompare(b[0]))
    .map(([project, e]) => readProjectEntry(vault, project, e.streams.sort()));
}
