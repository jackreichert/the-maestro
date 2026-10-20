/**
 * doctor.ts: the checks behind `scripts/doctor.ts`. Every check is a pure function of what it is handed (settings objects, paths, counts),
 * so a test feeds it fixtures and the CLI feeds it the machine. Nothing here writes a file or runs a fixing command.
 */
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

export type CheckStatus = 'ok' | 'warn' | 'skip';
export interface CheckResult { name: string; status: CheckStatus; detail: string }
export interface HookCommand { event: string; matcher: string; command: string }

/** The maestro hook script in a command (`.../scripts/hooks/git-guard.ts`): its path and file name, or undefined for any other command. */
export function maestroHookScript(command: string): { path: string; file: string } | undefined {
  const m = /'([^']*\/scripts\/hooks\/([\w-]+\.ts))'/.exec(command) ?? /(?:^|\s)((?:\/|~)[^\s'"]*\/scripts\/hooks\/([\w-]+\.ts))/.exec(command);
  return m ? { path: m[1], file: m[2] } : undefined;
}

/** Every hook command in a settings object's `hooks` key, any event. Anything else in the object (env, tokens) is ignored and never copied out. */
export function hookCommands(settings: unknown): HookCommand[] {
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: HookCommand[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as { matcher?: unknown; hooks?: unknown }[]) {
      for (const h of Array.isArray(entry?.hooks) ? (entry.hooks as { command?: unknown }[]) : []) {
        if (typeof h?.command === 'string') out.push({ event, matcher: typeof entry.matcher === 'string' ? entry.matcher : '', command: h.command });
      }
    }
  }
  return out;
}

/** The hook script file names a snippet object (the output of `print-settings-snippet.ts`) wants registered. Derived, never a second list. */
export function expectedHookFiles(snippet: unknown): string[] {
  return [...new Set(hookCommands(snippet).flatMap((c) => maestroHookScript(c.command)?.file ?? []))].sort();
}

/** Guards and hooks the snippet prints that no settings file registers. */
export function checkRegistered(expected: string[], registered: HookCommand[], settingsRead: string[]): CheckResult {
  const name = 'hooks registered';
  if (!settingsRead.length) return { name, status: 'skip', detail: 'no settings file could be read, so registration is unknown' };
  const have = new Set(registered.flatMap((c) => maestroHookScript(c.command)?.file ?? []));
  const missing = expected.filter((f) => !have.has(f));
  return missing.length
    ? { name, status: 'warn', detail: `not registered in ${settingsRead.join(', ')}: ${missing.join(', ')}. Print the entries with scripts/hooks/print-settings-snippet.ts and merge them yourself` }
    : { name, status: 'ok', detail: `all ${expected.length} hook scripts the snippet prints are registered` };
}

/** True when `path` is `root` or inside it, after resolving symlinks where the path exists. */
export function isInside(path: string, root: string, real: (p: string) => string = realpathSync): boolean {
  const norm = (p: string): string => { try { return real(p); } catch { return p; } };
  const r = norm(root).replace(/\/+$/, '');
  const p = norm(path);
  return p === r || p.startsWith(r + sep);
}

/** Registered maestro hooks that run from somewhere other than the runtime worktree. */
export function checkHookLocation(registered: HookCommand[], runtime: string | undefined, real?: (p: string) => string): CheckResult {
  const name = 'hooks run from the runtime worktree';
  if (!runtime) return { name, status: 'skip', detail: 'no runtime worktree is known (set MAESTRO_RUNTIME_WORKTREE or install the loop supervisor)' };
  const scripts = registered.flatMap((c) => maestroHookScript(c.command) ?? []);
  if (!scripts.length) return { name, status: 'skip', detail: 'no maestro hook is registered' };
  const outside = [...new Set(scripts.filter((s) => !isInside(s.path.replace(/^~/, process.env.HOME ?? '~'), runtime, real)).map((s) => s.path))];
  return outside.length
    ? { name, status: 'warn', detail: `${outside.length} of ${scripts.length} registered hooks run from outside ${runtime}: ${outside.join(', ')}` }
    : { name, status: 'ok', detail: `all ${scripts.length} registered hooks run from ${runtime}` };
}

/** The installed skill path (usually a symlink) must resolve into the runtime worktree. */
export function checkSkillLocation(skillPath: string | undefined, runtime: string | undefined, real?: (p: string) => string): CheckResult {
  const name = 'skill symlink resolves into the runtime worktree';
  if (!runtime) return { name, status: 'skip', detail: 'no runtime worktree is known' };
  if (!skillPath) return { name, status: 'skip', detail: 'no installed the-maestro skill path was found' };
  return isInside(skillPath, runtime, real)
    ? { name, status: 'ok', detail: `${skillPath} is inside ${runtime}` }
    : { name, status: 'warn', detail: `${skillPath} resolves outside ${runtime}, so a session runs whatever branch that checkout is on` };
}

/** A checkout (runtime or overlay) that is behind the local origin/main ref. `behind` is null when current, undefined when unreadable. */
export function checkBehind(name: string, where: string | undefined, behind: { behind: number } | null | undefined): CheckResult {
  if (!where) return { name, status: 'skip', detail: 'not configured' };
  if (behind === undefined) return { name, status: 'skip', detail: `${where} is not a readable git checkout` };
  return behind
    ? { name, status: 'warn', detail: `${where} is ${behind.behind} commit${behind.behind === 1 ? '' : 's'} behind origin/main (local ref; run git fetch for the latest)` }
    : { name, status: 'ok', detail: `${where} is at origin/main` };
}

export interface InstallFacts {
  /** Plugin names (without the marketplace) that are installed as plugins. */
  plugins: string[];
  /** Names found as loose files or links in the skills and commands folders, e.g. `mithril-review`, `mithril.md`. */
  loose: string[];
  /** Nested git clones found inside a skill checkout (a clone of something inside the-maestro). */
  nestedClones: string[];
}

/** A tool installed twice: as a plugin and as loose skill/command files that share its name, or a clone nested inside a checkout. */
export function checkDuplicateInstalls(f: InstallFacts): CheckResult {
  const name = 'no duplicate installs';
  const dupes = f.plugins.flatMap((p) => {
    const hits = f.loose.filter((l) => l === p || l === `${p}.md` || l.startsWith(`${p}-`));
    return hits.length ? [`${p} (plugin, plus ${hits.length} loose: ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', ...' : ''})`] : [];
  });
  const problems = [...dupes, ...f.nestedClones.map((c) => `nested clone ${c}`)];
  return problems.length
    ? { name, status: 'warn', detail: problems.join('; ') }
    : { name, status: 'ok', detail: 'no plugin is also installed as loose files, and no nested clone was found' };
}

/** A line per check, then a verdict line. */
export function render(results: CheckResult[]): string {
  const mark = { ok: 'ok  ', warn: 'WARN', skip: 'skip' } as const;
  const warns = results.filter((r) => r.status === 'warn').length;
  return [...results.map((r) => `${mark[r.status]}  ${r.name}: ${r.detail}`), warns ? `doctor: ${warns} problem${warns === 1 ? '' : 's'} found. Nothing was changed.` : 'doctor: no problems found.'].join('\n');
}
