/**
 * `journal.ts settings`: the values in effect and where each came from, and a doc check that flags a copy of a
 * setting kept outside the canonical place (the user config file). Pure functions over the resolved list, so tests
 * need no environment.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { overlayPath, resolvedSettings, userPath, VAULT_ROOT } from '../local-config.ts';
import type { ResolvedSetting } from '../local-config.ts';

/** Settings whose value could be a credential or a command line: shown as `(set)` and never printed. */
const SECRET_KEY = /(_command|secret|token|password)$/;

/** The value as it may be printed. */
export const displayValue = (s: ResolvedSetting): string => (s.value && SECRET_KEY.test(s.key) ? '(set)' : s.value);

/** One line per setting: key, value (or `(unset)`), source. Settings nothing sets are listed only with `all`. */
export function settingsLines(list: ResolvedSetting[], all = false): string[] {
  const shown = list.filter((s) => all || s.source !== 'default' || s.value !== '');
  const width = Math.max(0, ...shown.map((s) => s.key.length));
  return shown.map((s) => `${s.key.padEnd(width)}  ${(displayValue(s) || '(unset)').padEnd(24)}  ${s.source}`);
}

export interface SettingCopy { file: string; line: number; name: string; value: string }

/** Names that are also ordinary words are not matched by bare name. */
const matchable = (s: ResolvedSetting): string[] => [s.envName, s.key.includes('_') ? s.key : ''].filter(Boolean);

/**
 * Lines of `text` that give a known setting a literal value: `name: value`, `name = value` or `name=value`, with
 * the name as a whole word and optional backticks, and the value a number, a path or an on/off word (prose after a colon is not a value). A `maestro-config` fenced block is the canonical form and is skipped.
 */
export function findSettingCopies(file: string, text: string, list: ResolvedSetting[]): SettingCopy[] {
  const names = list.flatMap(matchable);
  if (!names.length) return [];
  const re = new RegExp(`(?<![\\w-])\`?(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\`?\\s*(?::|=)\\s*\`?(\\d[^\\s\`,;]*|[~/][^\\s\`,;]*|(?:on|off|true|false|yes|no)(?![\\w-]))`, 'g');
  const out: SettingCopy[] = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (/^```/.test(raw)) { fenced = !fenced && /^```maestro-config/.test(raw); return; }
    if (fenced) return;
    for (const m of raw.matchAll(re)) out.push({ file, line: i + 1, name: m[1] as string, value: m[2] as string });
  });
  return out;
}

/** The report lines for the copies found, each with the fix. */
export const copyLines = (copies: SettingCopy[]): string[] =>
  copies.map((c) => `${c.file}:${c.line}: ${c.name} is given the value ${c.value}; keep the value in the user config file and link to it here`);

/** Markdown files under `target`: the file itself, or every .md below a directory (dot-directories and node_modules skipped). */
function markdownFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((e) => (e.name.startsWith('.') || e.name === 'node_modules' ? [] : e.isDirectory() ? markdownFiles(join(target, e.name)) : e.name.endsWith('.md') ? [join(target, e.name)] : []));
}

/** The notes the check reads when no path is given: each project's CONTEXT.md in the vault. */
const defaultTargets = (): string[] => (VAULT_ROOT && existsSync(join(VAULT_ROOT, 'Projects'))
  ? readdirSync(join(VAULT_ROOT, 'Projects')).map((p) => join(VAULT_ROOT, 'Projects', p, 'CONTEXT.md'))
  : []);

/**
 * `journal.ts settings [--all]` prints the values in effect and their sources. `settings --check [path...]` reads the
 * given files or directories (default: each vault project's CONTEXT.md) and lists every known setting given a literal
 * value there. The user config file and the overlay file are the canonical places and are never flagged.
 * Returns the exit code: 0 clean, 1 copies found, 2 nothing to check.
 */
export function runSettings(opts: { all: boolean; check: boolean; paths: string[] }): number {
  const list = resolvedSettings();
  if (!opts.check) {
    console.log(`user config file: ${userPath || '(disabled)'}`);
    settingsLines(list, opts.all).forEach((l) => console.log(l));
    return 0;
  }
  const canonical = new Set([userPath, overlayPath].filter(Boolean).map((p) => resolve(p)));
  const targets = opts.paths.length ? opts.paths : defaultTargets();
  const files = [...new Set(targets.flatMap(markdownFiles).map((f) => resolve(f)))].filter((f) => !canonical.has(f));
  if (!files.length) { console.error('settings --check: no files to check (pass paths, or set vault_root)'); return 2; }
  const copies = files.flatMap((f) => findSettingCopies(f, readFileSync(f, 'utf8'), list));
  if (!copies.length) { console.log(`no setting copies found in ${files.length} files`); return 0; }
  copyLines(copies).forEach((l) => console.log(l));
  return 1;
}
