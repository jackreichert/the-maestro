#!/usr/bin/env node
/**
 * LIBRARY CHECK: the runtime check that a library page keeps the template (reference/library.md): required frontmatter, the controlled
 * vocabulary (kind, status, repo, components), a verified-at date, a dated evidence on every fact, a size budget, links (frontmatter and body wikilinks) that resolve to a note in the vault, and no
 * secret or PHI shape anywhere in the file.
 *
 *   node scripts/library-check.ts [--vault <root>] [--repo <name>] [--json] [<page.md> ...]
 *
 * With no page arguments it reads every page under Projects/<repo>/Knowledge (all of it) and Projects/<repo>/Runbooks (only files whose
 * frontmatter says `type: library`), one subfolder deep. Named pages (absolute, or relative to the vault) are checked instead.
 * It prints each finding as `path:line  rule  message`; a secret hit names the shape and the line, never the matched text. It writes nothing.
 * Exit codes: 0 every page passes; 1 any finding; 2 a usage or read error (no vault, a named page that cannot be read, a --repo that does not exist, or no pages found at all), never a silent pass.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_ROOT } from './local-config.ts';
import { linkTarget, list, parsePage } from './lib/library/page.ts';
import { checkPage } from './lib/library/rules.ts';
import type { Finding } from './lib/library/rules.ts';
import { locateBlock } from './lib/library/index-page.ts';
import type { Scanner } from './lib/library/scan.ts';

const USAGE = 'Usage: library-check.ts [--vault <root>] [--repo <name>] [--json] [<page.md> ...]';
const LIBRARY_FOLDERS = ['Knowledge', 'Runbooks'] as const;

interface Options { vault: string; repo?: string; json: boolean; pages: string[] }
export interface PageReport { path: string; findings: Finding[] }

export function parseOptions(argv: string[]): Options | string {
  let vault = VAULT_ROOT;
  let repo: string | undefined;
  let json = false;
  const pages: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--json') json = true;
    else if (a === '--vault' || a === '--repo') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
      if (a === '--vault') vault = v; else repo = v;
      i += 1;
    } else if (a.startsWith('--')) return `unknown argument ${a}`;
    else pages.push(a);
  }
  if (!vault) return 'vault root is not set; set VAULT_ROOT (or vault_root in the local config) or pass --vault <path>';
  return { vault, repo, json, pages };
}

/** Real directories and files only: a symlink is skipped, so a link in a library folder cannot lead the check outside the vault. */
const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const markdown = (p: string): string[] => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name) : []);

/** True when `rel` (vault-relative) is a real file whose resolved path stays inside the vault. */
export function insideVault(vault: string, rel: string): boolean {
  try {
    const root = realpathSync(vault);
    const real = realpathSync(join(vault, rel));
    return real.startsWith(root + sep) && statSync(real).isFile();
  } catch { return false; }
}

/** Vault-relative paths of the library pages: Knowledge and one subfolder of it, and the `type: library` files of Runbooks. */
export function discover(vault: string, repo?: string): string[] {
  const projects = repo ? [repo] : dirs(join(vault, 'Projects'));
  return projects.flatMap((project) => LIBRARY_FOLDERS.flatMap((folder) => {
    const base = join('Projects', project, folder);
    const where = [base, ...dirs(join(vault, base)).map((d) => join(base, d))];
    return where.flatMap((w) => markdown(join(vault, w)).map((f) => join(w, f)))
      .filter((rel) => folder === 'Knowledge' || parsePage(rel, readFileSync(join(vault, rel), 'utf8')).fields.get('type') === 'library');
  }));
}

/** Every note and file in the vault outside hidden folders, as the names a link can use: a note by its base name, any other file by its full name. Real directories only. */
export function vaultNames(vault: string): Set<string> {
  const names = new Set<string>();
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(vault, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(join(rel, e.name));
      else if (e.isFile()) names.add(e.name.endsWith('.md') ? basename(e.name, '.md') : e.name);
    }
  };
  walk('');
  return names;
}

/** The component list a repo declares in `Projects/<repo>/INDEX.md`, or null when there is none. */
export function componentsOf(vault: string, repo: string): Set<string> | null {
  const file = join(vault, 'Projects', repo, 'INDEX.md');
  if (!existsSync(file)) return null;
  const c = list(parsePage(file, readFileSync(file, 'utf8')), 'components');
  return c.length ? new Set(c) : null;
}

/** The report for each page. `pages` are vault-relative paths. */
export function checkVault(vault: string, pages: string[], scan?: Scanner): PageReport[] {
  const repos = new Set(dirs(join(vault, 'Projects')));
  let names: Set<string> | undefined;
  const resolves = (raw: string): boolean => {
    const ref = linkTarget(raw);
    if (!ref || ref.split('/').includes('..') || isAbsolute(ref)) return false;
    if (ref.includes('/')) return insideVault(vault, `${ref}.md`) || insideVault(vault, ref);
    names ??= vaultNames(vault);
    return names.has(ref);
  };
  return pages.map((path) => {
    const project = path.split('/')[1] ?? '';
    return { path, findings: checkPage(parsePage(path, readFileSync(join(vault, path), 'utf8')), { project, repos, components: componentsOf(vault, project), resolves, ...(scan ? { scan } : {}) }) };
  });
}

/** The INDEX.md files (`repo` limits it to one project) whose generated-block markers are not exactly one well-formed pair: `library-index.ts` refuses to rewrite them, so a person has to fix them. Files with no markers are fine. */
export function indexReports(vault: string, repo?: string): PageReport[] {
  return (repo ? [repo] : dirs(join(vault, 'Projects'))).flatMap((project) => {
    const path = join('Projects', project, 'INDEX.md');
    if (!insideVault(vault, path)) return [];
    const at = locateBlock(readFileSync(join(vault, path), 'utf8'));
    return at.kind === 'bad' ? [{ path, findings: [{ rule: 'index-markers', message: `${at.why}; library-index.ts will not rewrite this file` }] }] : [];
  });
}

export function render(reports: PageReport[], extra: PageReport[] = []): string[] {
  const bad = reports.filter((r) => r.findings.length);
  return [
    ...[...bad, ...extra].flatMap((r) => r.findings.map((f) => `${r.path}${f.line ? `:${f.line}` : ''}  ${f.rule}  ${f.message}`)),
    `library-check: ${reports.length} page${reports.length === 1 ? '' : 's'} checked, ${bad.length} failing, ${reports.reduce((n, r) => n + r.findings.length, 0)} finding${reports.reduce((n, r) => n + r.findings.length, 0) === 1 ? '' : 's'}${extra.length ? `, ${extra.length} INDEX.md with malformed block markers` : ''}.`,
  ];
}

function main(argv: string[]): number {
  const o = parseOptions(argv);
  if (typeof o === 'string') { console.error(`library-check: ${o}\n${USAGE}`); return 2; }
  if (!existsSync(join(o.vault, 'Projects'))) { console.error(`library-check: no Projects folder under ${o.vault}`); return 2; }
  const named = o.pages.map((p) => (isAbsolute(p) ? relative(o.vault, p) : p));
  const unreadable = named.filter((p) => !insideVault(o.vault, p));
  if (unreadable.length) { console.error(`library-check: cannot read, or outside the vault: ${unreadable.join(', ')}`); return 2; }
  if (o.repo && !/^[\w.-]+$/.test(o.repo)) { console.error('library-check: --repo must be a plain project folder name'); return 2; }
  if (o.repo && !existsSync(join(o.vault, 'Projects', o.repo))) { console.error(`library-check: no project "${o.repo}" under ${join(o.vault, 'Projects')}`); return 2; }
  const pages = named.length ? named : discover(o.vault, o.repo);
  if (!pages.length) { console.error('library-check: no library pages found (a wrong --vault or --repo, or a renamed Knowledge folder); nothing was checked'); return 2; }
  const reports = checkVault(o.vault, pages);
  // Named pages are checked alone; the generated INDEX.md files are part of a whole run.
  const indexes = named.length ? [] : indexReports(o.vault, o.repo);
  if (o.json) console.log(JSON.stringify([...reports, ...indexes], null, 2)); else render(reports, indexes).forEach((l) => console.log(l));
  return reports.some((r) => r.findings.length) || indexes.length ? 1 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
