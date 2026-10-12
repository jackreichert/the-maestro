/** Library coverage: which of the required page kinds each project's library lacks. Reads the library; writes nothing. */
import type { LibraryPage } from './pages.ts';

/**
 * The page kinds every project library must cover, in reading order. This is the one list: the `covers` vocabulary rule and the coverage report both read it.
 * A page declares what it covers in its optional `covers` frontmatter list (the existing `kind` field is a different axis: how-to, runbook and so on).
 */
export const REQUIRED_PAGES = [
  { id: 'setup', title: 'Setup from scratch' },
  { id: 'run-local', title: 'Run locally' },
  { id: 'test-staging', title: 'Test in staging' },
  { id: 'verify-prod', title: 'Verify in prod (read-only checks)' },
  { id: 'deploy', title: 'Deploy path' },
  { id: 'how-it-works', title: 'How it works end to end' },
] as const;
export const COVERS = REQUIRED_PAGES.map((p) => p.id);

export interface ProjectCoverage {
  repo: string;
  /** Library pages counted (superseded pages are not). */
  pages: number;
  /** Required page ids covered, and, per id, the pages that cover it. */
  covered: Record<string, string[]>;
  missing: string[];
}

/** One row per project that has a library page, sorted by repo. `coversOf` is the `covers` list of a page path. */
export function coverage(pages: LibraryPage[], coversOf: (path: string) => string[]): ProjectCoverage[] {
  const byRepo = new Map<string, LibraryPage[]>();
  for (const p of pages) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
  return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repo, ps]) => {
    const live = ps.filter((p) => p.status !== 'superseded');
    const covered: Record<string, string[]> = {};
    for (const { id } of REQUIRED_PAGES) {
      const paths = live.filter((p) => coversOf(p.path).includes(id)).map((p) => p.path);
      if (paths.length) covered[id] = paths;
    }
    return { repo, pages: live.length, covered, missing: COVERS.filter((id) => !covered[id]) };
  });
}

export function renderCoverage(rows: ProjectCoverage[]): string[] {
  const title = (id: string): string => REQUIRED_PAGES.find((p) => p.id === id)?.title ?? id;
  return [
    ...rows.map((r) => `${r.repo}  ${r.missing.length ? `missing ${r.missing.length}/${COVERS.length}: ${r.missing.map(title).join('; ')}` : 'complete'}`),
    `library-check --coverage: ${rows.length} project${rows.length === 1 ? '' : 's'}, ${rows.filter((r) => r.missing.length).length} with missing pages`,
  ];
}
