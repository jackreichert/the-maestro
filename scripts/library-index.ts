#!/usr/bin/env node
/**
 * LIBRARY INDEX: generates the page list in each project's INDEX.md from the library pages, so a person or an agent that knows the repo
 * but not the words can browse it (`journal.ts find` is the search path).
 *
 *   node scripts/library-index.ts [--vault <root>] [--repo <name>] [--dry-run] [--check]
 *
 * Only the block between `<!-- library-index:start -->` and `<!-- library-index:end -->` is written; the frontmatter (the `components`
 * vocabulary) and every other line stay as they are. A file with no markers gets the block appended under `## Pages`; a hand-written list
 * above it is left for a person to remove. A project with pages but no INDEX.md is skipped and named: the component list is a deliberate
 * edit, so this never creates the file. A rerun with no page change writes nothing. --dry-run prints what would change; --check does the
 * same and exits 1 when any INDEX.md is out of date. Exit 2 on a usage or read error.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_ROOT } from './local-config.ts';
import { readLibrary } from './lib/library/pages.ts';
import { END, START, mergeIndex, renderBlock } from './lib/library/index-page.ts';

const USAGE = 'Usage: library-index.ts [--vault <root>] [--repo <name>] [--dry-run] [--check]';

export interface IndexResult { repo: string; file: string; pages: number; status: 'updated' | 'unchanged' | 'no-index' | 'appended' | 'malformed'; why?: string }

/** Regenerates the page list of every project that has library pages (or of `repo`). Writes unless `dryRun`. */
export function generate(vault: string, repo: string | undefined, dryRun: boolean): IndexResult[] {
  const pages = readLibrary(vault, repo);
  const byRepo = new Map<string, typeof pages>();
  for (const p of pages) {
    const project = p.path.split('/')[1] as string;
    byRepo.set(project, [...(byRepo.get(project) ?? []), p]);
  }
  // A project whose last page is gone still has a block listing it: visit every INDEX.md that carries the markers and write an empty block.
  const projects = repo ? [repo] : readdirSync(join(vault, 'Projects'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const project of projects) {
    const file = join(vault, 'Projects', project, 'INDEX.md');
    if (!byRepo.has(project) && existsSync(file) && lstatSync(file).isFile() && readFileSync(file, 'utf8').split('\n').some((l) => [START, END].some((m) => l.includes(m)))) byRepo.set(project, []);
  }
  return [...byRepo].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([project, list]): IndexResult => {
    const file = join(vault, 'Projects', project, 'INDEX.md');
    const base = { repo: project, file, pages: list.length };
    // A symlinked INDEX.md could lead the write outside the vault; only a real file is touched.
    if (!existsSync(file) || !lstatSync(file).isFile()) return { ...base, status: 'no-index' };
    const before = readFileSync(file, 'utf8');
    const merged = mergeIndex(before, renderBlock(list));
    if (merged.state === 'malformed') return { ...base, status: 'malformed', ...(merged.why ? { why: merged.why } : {}) };
    if (merged.text === before) return { ...base, status: 'unchanged' };
    if (!dryRun) {
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, merged.text);
      renameSync(tmp, file);
    }
    return { ...base, status: merged.state === 'replaced' ? 'updated' : 'appended' };
  });
}

function main(argv: string[]): number {
  let vault = VAULT_ROOT;
  let repo: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--vault' || a === '--repo') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { console.error(`library-index: ${a} needs a value\n${USAGE}`); return 2; }
      if (a === '--vault') vault = v; else repo = v;
      i += 1;
    } else if (a === '--dry-run' || a === '--check') flags.add(a);
    else { console.error(`library-index: unknown argument ${a}\n${USAGE}`); return 2; }
  }
  if (!vault || !existsSync(join(vault, 'Projects'))) { console.error('library-index: no vault with a Projects folder; set VAULT_ROOT or pass --vault <path>'); return 2; }
  if (repo && !/^[\w.-]+$/.test(repo)) { console.error('library-index: --repo must be a plain project folder name'); return 2; }
  const preview = flags.has('--dry-run') || flags.has('--check');
  const results = generate(vault, repo, preview);
  if (!results.length) { console.error('library-index: no library pages found; nothing was indexed'); return 2; }
  for (const r of results) {
    const note = r.status === 'no-index' ? 'skipped: no INDEX.md (create it with a components list first)'
      : r.status === 'malformed' ? `NOT rewritten, left as it was: ${r.why ?? 'the block markers are malformed'}; fix the file by hand (library-check reports it)`
      : r.status === 'appended' ? `${preview ? 'would append' : 'appended'} a ## Pages block (remove any hand-written page list above it)`
      : r.status === 'updated' ? (preview ? 'would update' : 'updated') : 'unchanged';
    console.log(`${r.repo}: ${r.pages} page${r.pages === 1 ? '' : 's'}, ${note}`);
  }
  if (results.some((r) => r.status === 'malformed')) return 1;
  return flags.has('--check') && results.some((r) => r.status === 'updated' || r.status === 'appended') ? 1 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
