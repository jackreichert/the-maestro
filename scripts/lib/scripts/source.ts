/**
 * The source of the script files a registered command runs, for the Scripts tab to show read-only.
 *
 * The page never names a path: the server derives the files from the registered command (and, one level down, from the files that command's
 * script sources or feeds to a tool), then serves only what passes every check here. Nothing in this module runs or edits a file.
 *
 * What stops a file being shown, in order: a `..` in the path, a path outside the configured roots (lexically, then after resolving
 * symlinks), a secret-bearing file name (`.env*`, `ssm-*.json`, `*.tfvars`, `*.tfstate*`, `*.pem`, `*.key`) checked on the name given and on
 * the resolved name, anything that is not a regular file, a size over 200 KB, binary content, and content the secret scan flags (the body is
 * replaced, never trimmed). A refused file is still listed, with its reason, so the reader knows it exists and why it is not shown.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { secretShaped } from '../withhold.ts';

export const MAX_SOURCE_BYTES = 200 * 1024;
const MAX_INCLUDES = 8;
const MAX_FILES = 12;

/** Names that hold secrets or state with secrets in it. Tested on the basename, case-insensitively. */
const DENIED_NAME = /^\.env(?:\..*)?$|^ssm-.*\.json$|\.tfvars(?:\.json)?$|\.tfstate(?:\..*)?$|\.pem$|\.key$/i;
/** Extensions treated as a script, or a file a script feeds to a tool. */
const EXT = '(?:sh|bash|zsh|ts|mjs|js|cjs|py|rb|sql)';
/** What a script says to mean "the folder I am in"; each form is replaced by HERE before paths are read. */
const HERE_FORMS = [
  /\$\(\s*cd\s+"?\$\(\s*dirname\s+"?\$\{?(?:0|BASH_SOURCE(?:\[0\])?)\}?"?\s*\)"?\s*&&\s*pwd\s*\)/g,
  /\$\(\s*dirname\s+"?\$\{?(?:0|BASH_SOURCE(?:\[0\])?)\}?"?\s*\)/g,
  /\$\{(?:0|BASH_SOURCE(?:\[0\])?)%\/\*\}/g,
  /\$\{?(?:SCRIPT_DIR|HERE|DIR|SCRIPTDIR|SCRIPT_PATH|BASEDIR)\}?/g,
];
const HERE = '\u0001';
const PATH_RE = new RegExp(String.raw`(?:^|[\s=(:,])((?:${HERE}|~|\$\{?HOME\}?|/)[^\s;|&<>(){}]*\.${EXT})(?=$|[\s;|&<>()},:])`, 'gm');
const SIBLING_RE = new RegExp(String.raw`(?:^|[\s;&|(])(?:source|\.|-f|--file)[\s=]+([A-Za-z0-9_][A-Za-z0-9_./-]*\.${EXT})(?=$|[\s;|&)])`, 'gm');

export type Marks = Record<number, 'mutates' | 'gate'>;
export interface SourceFile {
  /** Absolute path as the command or include named it, with `~` and `$HOME` expanded. */
  path: string;
  role: 'script' | 'include';
  /** Present only when the file is shown. */
  text?: string;
  /** 1-based line number to `mutates` or `gate`; a line with both counts as `mutates`. Empty when the body is not shown. */
  marks: Marks;
  lines: number;
  mutates: number;
  gates: number;
  /** ISO time, when the file could be stat-ed. */
  modified?: string;
  /** Why the body is not shown: `missing`, `outside the script roots`, `hidden: possible secret`, ... */
  hidden?: string;
  /** Marked as mutating but with no gate marker anywhere: the reader should look closer. */
  warn: boolean;
}

const expand = (p: string): string => p.replace(/^~(?=\/|$)/, homedir()).replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());

/** True for a name that must never be served, whatever folder it sits in. */
export const deniedName = (name: string): boolean => DENIED_NAME.test(name);

/** Lines carrying a marker (`MUTATES:` also covers SQL's `-- MUTATES:`). `MUTATES:` wins over `GATE:` on the same line. */
export function markersOf(text: string): { marks: Marks; mutates: number; gates: number } {
  const marks: Marks = {};
  let mutates = 0;
  let gates = 0;
  text.split('\n').forEach((line, i) => {
    if (line.includes('MUTATES:')) { marks[i + 1] = 'mutates'; mutates += 1; } else if (line.includes('GATE:')) { marks[i + 1] = 'gate'; gates += 1; }
  });
  return { marks, mutates, gates };
}

const refused = (path: string, role: SourceFile['role'], hidden: string, extra: Partial<SourceFile> = {}): SourceFile => ({ path, role, marks: {}, lines: 0, mutates: 0, gates: 0, warn: false, hidden, ...extra });

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The roots as real paths; a root that does not exist is dropped. */
const realRoots = (roots: string[]): string[] => roots.flatMap((r) => { try { return [realpathSync(resolve(expand(r)))]; } catch { return []; } });

/** Reads one file for display, or says why it is not shown. Never throws. */
export function readSource(rawPath: string, roots: string[], role: SourceFile['role'] = 'script'): SourceFile {
  const path = expand(rawPath);
  if (!isAbsolute(path) || path.includes('\0')) return refused(path, role, 'not an absolute path');
  if (path.split(/[\\/]/).includes('..')) return refused(path, role, 'path contains ..');
  const lexical = resolve(path);
  const rootsReal = realRoots(roots);
  const rootsLexical = roots.map((r) => resolve(expand(r)));
  // Outside the roots lexically: say so without touching the disk, so the answer never reveals whether the file exists.
  if (![...rootsLexical, ...rootsReal].some((r) => within(lexical, r))) return refused(path, role, 'outside the script roots');
  if (deniedName(basename(lexical))) return refused(path, role, 'hidden: secret-bearing file name');
  let real: string;
  try { real = realpathSync(lexical); } catch { return refused(path, role, 'missing'); }
  if (!rootsReal.some((r) => within(real, r))) return refused(path, role, 'outside the script roots (a link leads out of them)');
  if (deniedName(basename(real))) return refused(path, role, 'hidden: secret-bearing file name');
  try {
    const st = statSync(real);
    if (!st.isFile()) return refused(path, role, 'not a regular file');
    const modified = st.mtime.toISOString();
    if (st.size > MAX_SOURCE_BYTES) return refused(path, role, `too large to show (over ${MAX_SOURCE_BYTES / 1024} KB)`, { modified });
    const buf = readFileSync(real);
    if (buf.includes(0)) return refused(path, role, 'binary file', { modified });
    const text = buf.toString('utf8');
    const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
    const { marks, mutates, gates } = markersOf(text);
    const base = { path, role, marks, lines, mutates, gates, modified, warn: gates === 0 && mutates > 0 };
    // The whole file or nothing: dropping single lines would hide which were dropped. Counts come from the real text.
    if (secretShaped(text)) return { ...base, marks: {}, hidden: 'hidden: possible secret' };
    return { ...base, text };
  } catch { return refused(path, role, 'missing'); }
}

/** Absolute paths a block of text names (`~/`, `$HOME/`, `/`, or the script's own folder), ending in a script-like extension. */
export function pathsIn(text: string, here: string | null): string[] {
  let t = text;
  for (const re of HERE_FORMS) t = t.replace(re, HERE);
  t = t.replace(/["'`]/g, '');
  const out: string[] = [];
  const add = (p: string): void => {
    const abs = p.startsWith(HERE) ? (here ? join(here, p.slice(1)) : '') : expand(p);
    if (abs && isAbsolute(abs) && !out.includes(abs)) out.push(abs);
  };
  for (const m of t.matchAll(PATH_RE)) add(m[1] ?? '');
  // A bare name after `source`, `.` or an `-f`/`--file` flag is a sibling of the script.
  if (here) for (const m of t.matchAll(SIBLING_RE)) add(`${HERE}/${m[1] ?? ''}`);
  return out;
}

/**
 * The files a registered command runs, then the files its scripts name (one level, no deeper), each read for display. A path outside the roots
 * is listed with its reason and never opened. Includes come only from files that are shown, so a hidden file cannot lead anywhere.
 */
export function sourcesOf(command: string, roots: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  const seen = new Set<string>();
  const take = (path: string, role: SourceFile['role']): void => {
    if (seen.has(path) || files.length >= MAX_FILES) return;
    seen.add(path);
    files.push(readSource(path, roots, role));
  };
  for (const p of pathsIn(command, null)) take(p, 'script');
  let includes = 0;
  for (const f of [...files]) {
    if (f.text === undefined) continue;
    for (const p of pathsIn(f.text, dirname(resolve(f.path)))) {
      if (includes >= MAX_INCLUDES || seen.has(p)) continue;
      includes += 1;
      take(p, 'include');
    }
  }
  return files;
}
