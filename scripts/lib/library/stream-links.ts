/** Which library a stream has: the project folders behind it and the library INDEX note of each that exists. Pure; callers pass the vault lookup. */
import { slugOf } from '../home/mapping.ts';
import { obsidianUri } from '../status-page/links.ts';

export interface StreamLibraryLink { project: string; label: string; url: string }

/**
 * The project folders a stream owns: the ones `stream-homes.json` lists, else the folder named like the stream and the repos
 * `status_repo_streams` maps to it, each kept only when `hasNote` says it has a note to show.
 */
export function streamProjects(stream: string, listed: readonly string[], repoStreams: Readonly<Record<string, string>>, hasNote: (project: string) => boolean): string[] {
  if (listed.length) return [...listed];
  const repos = Object.entries(repoStreams).filter(([, s]) => s === stream).map(([repo]) => repo);
  return [...new Set([slugOf(stream), ...repos].filter((p) => p && hasNote(p)))];
}

/** One link per project whose `Projects/<project>/INDEX.md` exists. Nothing without a vault name: a link must name its vault, and a missing note is never linked. */
export function streamLibraryLinks(vaultName: string, projects: readonly string[], exists: (vaultPath: string) => boolean): StreamLibraryLink[] {
  if (!vaultName) return [];
  return projects.filter((p) => exists(`Projects/${p}/INDEX.md`)).map((project) => ({ project, label: `${project} library`, url: obsidianUri(vaultName, `Projects/${project}/INDEX`) }));
}
