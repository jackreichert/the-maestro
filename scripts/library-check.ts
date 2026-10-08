#!/usr/bin/env node
/**
 * LIBRARY CHECK: the runtime check that a library page keeps the template (reference/library.md): required frontmatter, the controlled
 * vocabulary (kind, status, repo, components), a verified-at date, a dated evidence on every fact, a size budget, links that resolve, and no
 * secret or PHI shape anywhere in the file.
 *
 *   node scripts/library-check.ts [--vault <root>] [--repo <name>] [--json] [<page.md> ...]
 *
 * With no page arguments it reads every page under Projects/<repo>/Knowledge (all of it) and Projects/<repo>/Runbooks (only files whose
 * frontmatter says `type: library`), one subfolder deep. Named pages (absolute, or relative to the vault) are checked instead.
 * It prints each finding as `path:line  rule  message`; a secret hit names the shape and the line, never the matched text. It writes nothing.
 * Exit codes: 0 every page passes; 1 any finding; 2 a usage or read error (no vault, a named page that cannot be read), never a silent pass.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_ROOT } from './local-config.ts';
import { list, parsePage } from './lib/library/page.ts';
import { checkPage } from './lib/library/rules.ts';
import type { Finding } from './lib/library/rules.ts';
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

const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()) : []);
const markdown = (p: string): string[] => (existsSync(p) ? readdirSync(p).filter((n) => n.endsWith('.md') && statSync(join(p, n)).isFile()) : []);

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
  const names = new Set(discover(vault).map((p) => basename(p, '.md')));
  const resolves = (raw: string): boolean => {
    const ref = raw.replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').replace(/\.md$/, '');
    return ref.includes('/') ? existsSync(join(vault, `${ref}.md`)) : names.has(ref);
  };
  return pages.map((path) => {
    const project = path.split('/')[1] ?? '';
    return { path, findings: checkPage(parsePage(path, readFileSync(join(vault, path), 'utf8')), { project, repos, components: componentsOf(vault, project), resolves, ...(scan ? { scan } : {}) }) };
  });
}

export function render(reports: PageReport[]): string[] {
  const bad = reports.filter((r) => r.findings.length);
  return [
    ...bad.flatMap((r) => r.findings.map((f) => `${r.path}${f.line ? `:${f.line}` : ''}  ${f.rule}  ${f.message}`)),
    `library-check: ${reports.length} page${reports.length === 1 ? '' : 's'} checked, ${bad.length} failing, ${reports.reduce((n, r) => n + r.findings.length, 0)} finding${reports.reduce((n, r) => n + r.findings.length, 0) === 1 ? '' : 's'}.`,
  ];
}

function main(argv: string[]): number {
  const o = parseOptions(argv);
  if (typeof o === 'string') { console.error(`library-check: ${o}\n${USAGE}`); return 2; }
  if (!existsSync(join(o.vault, 'Projects'))) { console.error(`library-check: no Projects folder under ${o.vault}`); return 2; }
  const named = o.pages.map((p) => (isAbsolute(p) ? relative(o.vault, p) : p));
  const unreadable = named.filter((p) => !existsSync(join(o.vault, p)));
  if (unreadable.length) { console.error(`library-check: cannot read ${unreadable.join(', ')}`); return 2; }
  const reports = checkVault(o.vault, named.length ? named : discover(o.vault, o.repo));
  if (o.json) console.log(JSON.stringify(reports, null, 2)); else render(reports).forEach((l) => console.log(l));
  return reports.some((r) => r.findings.length) ? 1 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
