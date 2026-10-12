/**
 * Writes one day's container priorities list into each project's own file (`Projects/<project>/Status/priorities/<day>.md`).
 * `journal.ts priorities set` and the Podium's edit routes both call this, so the container list and the project files cannot
 * drift apart. It reads the vault and writes only those files; it never touches `priorities.md` and never throws for one project.
 */
import { join } from 'node:path';
import type { LedgerRow, RegistryLookup } from '../ledger-core.ts';
import { readHomes } from '../home/config.ts';
import type { Priority } from './priorities.ts';
import { carriedInto, droppedProjects, fanOut, nextItems, prioritiesDir, projectsFor, readProjectFile, writeProjectPriorities } from './project-priorities.ts';

export interface SyncInput {
  /** The notes vault holding `Projects/<project>/`. */
  vaultRoot: string;
  /** The status directory, where `stream-homes.json` says which projects a stream maps to. */
  statusDir: string;
  /** The day being written. */
  day: string;
  /** The local day today; a `day` before it is refused for each project. */
  today: string;
  /** The container list for `day`, in order. */
  items: Priority[];
  rows: LedgerRow[];
  registry: RegistryLookup | null;
  repoStreams: Record<string, string>;
  containerProject: string;
}

export interface SyncResult {
  /** One line per project: `wrote <path>` or `skipped <name>: no vault folder Projects/<name>`. */
  lines: string[];
  /** One line per project that could not be written; the others were still written. */
  problems: string[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A project with Today items for `day` that this list no longer names is cleared, so a dropped item is neither shown nor carried. Carried sections are kept; a day's first file is seeded with the carry's own items, so an edit before the carry loses nothing. */
export function syncProjectPriorities(input: SyncInput): SyncResult {
  const { vaultRoot, statusDir, day, today, items, rows, registry, repoStreams, containerProject } = input;
  const homes = readHomes(statusDir, Object.keys(registry?.streams ?? {}));
  const route = (s: string | undefined): string[] => projectsFor(s, homes, repoStreams, containerProject);
  const fanned = fanOut(items, route);
  const dropped = droppedProjects(vaultRoot, day, fanned.keys());
  const result: SyncResult = { lines: [], problems: [] };
  for (const [name, mine] of [...fanned, ...dropped.map((name): [string, Priority[]] => [name, []])]) {
    try {
      const streams = [...new Set(mine.map((p) => p.stream).filter((s): s is string => Boolean(s)))];
      const path = join(prioritiesDir(vaultRoot, name), `${day}.md`);
      const kept = readProjectFile(path);
      const carry = kept ?? (day === today ? carriedInto({ vault: vaultRoot, project: name, today, rows, registry, fromContainer: [] }) : { carriedFrom: '', carried: [] });
      const written = writeProjectPriorities(vaultRoot, name, today, { project: name, date: day, carriedFrom: carry.carriedFrom, writtenBy: 'priorities set', today: mine, carried: carry.carried, next: nextItems(rows, registry, streams) });
      result.lines.push(written === 'written' ? `wrote ${path}` : `skipped ${name}: no vault folder Projects/${name}`);
    } catch (e) { result.problems.push(`project ${name}: ${message(e).split('\n')[0].slice(0, 100)}`); }
  }
  return result;
}
