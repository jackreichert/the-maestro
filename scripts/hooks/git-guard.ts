#!/usr/bin/env node
/**
 * git-guard.ts: a Claude Code PreToolUse hook for the Bash tool that turns "ask before a risky git command" from prose into a
 * runtime check. The idea (a hook that stops dangerous git before it runs) comes from mattpocock/skills,
 * https://github.com/mattpocock/skills/tree/main/skills/misc/git-guardrails-claude-code ; this version is our own: it answers
 * ASK, not deny, so the harness shows its normal permission prompt and you decide.
 *
 * It asks for: a push to main, staging or develop (or one that cannot be shown to avoid them), any force push, reset, rebase,
 * merge, cherry-pick, revert, `add -A` / `add .`, `commit -a`, `branch -D`, `clean -f`, a checkout / restore / switch that
 * discards work, and a commit while HEAD is a protected branch. Everything else (status, diff, log, show, fetch, ls-remote,
 * rev-parse, blame, plain commit or push on a feature branch, add by explicit path) passes with no output.
 *
 * Compound commands are split (&&, ||, ;, |, &, newlines, subshells, $(...), backticks, `bash -c "..."`, `eval`, wrapper
 * commands such as env/sudo/xargs, `git -C dir`, `git -c alias.x=...` and aliases from the repo's own config), so a risky verb
 * hidden in a chain is still seen. Failure mode: if the hook itself breaks (bad input, an internal error) it writes a note to
 * stderr and allows, because a broken guard must not brick the session. It is a safety net for an assistant's honest
 * mistakes, not a sandbox: a determined script (a git alias file, a Makefile target that runs git) can still get past it.
 *
 * Protected branches default to main, staging, develop; set GIT_GUARD_PROTECTED (comma separated) to change them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GuardContext {
  cwd: string;
  /** Current branch of the repo found through `gitArgs`: a name, '' for a detached HEAD, undefined when it cannot be read. */
  branch: (dir: string, gitArgs: string[]) => string | '' | undefined;
  /** The repo's `alias.*` config, name to value. */
  aliases: (dir: string, gitArgs: string[]) => Record<string, string>;
}
export interface Decision { ask: boolean; reasons: string[] }

const PROTECTED = (process.env.GIT_GUARD_PROTECTED ?? 'main,staging,develop').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_DEPTH = 6;

// ───────────────────────────── entry point ─────────────────────────────

/** Decide for a whole Bash command string; every risky git invocation found adds a reason. */
export function decide(command: string, ctx: GuardContext): Decision {
  const reasons: string[] = [];
  analyse(command, ctx.cwd, ctx, reasons, 0);
  return { ask: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** The hook: stdin JSON in, a PreToolUse ASK object (or nothing) out. Never throws; any failure allows. */
export function run(stdin: string, ctx: Partial<GuardContext> = {}, decider: typeof decide = decide): { stdout: string; stderr: string } {
  try {
    const input = JSON.parse(stdin) as { tool_name?: string; tool_input?: { command?: unknown }; cwd?: string };
    if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return { stdout: '', stderr: '' };
    const full: GuardContext = { cwd: input.cwd || process.cwd(), branch: gitBranch, aliases: gitAliases, ...ctx };
    const d = decider(input.tool_input.command, full);
    if (!d.ask) return { stdout: '', stderr: '' };
    const reason = `git-guard: ${d.reasons.join('; ')}. Your rules say to ask before this.`;
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }), stderr: '' };
  } catch (e) {
    return { stdout: '', stderr: `git-guard: could not check this command (${e instanceof Error ? e.message : String(e)}); allowing it so the session is not blocked\n` };
  }
}

// ───────────────────────────── shell parsing ─────────────────────────────

interface Word { text: string; redirect: boolean }
const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')']);

/** Split a shell string into command segments of words; `$(...)` and backtick bodies come back in `nested`, and the word they sit in keeps a `$(...)` placeholder so the words after it stay in the same command. Lenient: unterminated quotes run to the end. */
export function split(src: string): { segments: Word[][]; nested: string[] } {
  const segments: Word[][] = [];
  const nested: string[] = [];
  let words: Word[] = [];
  let cur: Word | undefined;
  const push = (): void => { if (cur) words.push(cur); cur = undefined; };
  const endSegment = (): void => { push(); if (words.length) segments.push(words); words = []; };
  const add = (c: string): void => { cur ??= { text: '', redirect: false }; cur.text += c; };
  const heredocs: Heredoc[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const ar = arithAt(src, i, !cur);
    if (ar) { subsIn(ar.body, nested); i = ar.end; add(ar.dollar ? '$((...))' : '((...))'); continue; }
    if (c === '<') { const h = heredocAt(src, i); if (h) heredocs.push(h); }
    if (c === '\n' && heredocs.length) { endSegment(); i = skipHeredocs(src, i + 1, heredocs, nested) - 1; continue; }
    if (c === '\\') { if (i + 1 < src.length) { i++; if (src[i] !== '\n') add(src[i]); } continue; }
    if (c === "'") { cur ??= { text: '', redirect: false }; const j = src.indexOf("'", i + 1); const end = j < 0 ? src.length : j; cur.text += src.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      cur ??= { text: '', redirect: false };
      i++;
      for (; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && i + 1 < src.length) { i++; cur.text += src[i]; continue; }
        const qa = arithAt(src, i, false);
        if (qa) { subsIn(qa.body, nested); i = qa.end; cur.text += '$((...))'; continue; }
        if (src[i] === '$' && src[i + 1] === '(') { const e = closeParen(src, i + 2); nested.push(src.slice(i + 2, e)); i = e; cur.text += '$(...)'; continue; }
        if (src[i] === '`') { const e = src.indexOf('`', i + 1); const end = e < 0 ? src.length : e; nested.push(src.slice(i + 1, end)); i = end; cur.text += '$(...)'; continue; }
        cur.text += src[i];
      }
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { const e = closeParen(src, i + 2); nested.push(src.slice(i + 2, e)); i = e; add('$(...)'); continue; }
    if (c === '`') { const e = src.indexOf('`', i + 1); const end = e < 0 ? src.length : e; nested.push(src.slice(i + 1, end)); i = end; add('$(...)'); continue; }
    if (c === '#' && !cur) { while (i < src.length && src[i] !== '\n') i++; i--; continue; }
    if (c === '>' || c === '<') { if (!cur || /^\d+$/.test(cur.text)) { cur ??= { text: '', redirect: false }; cur.redirect = true; } add(c); continue; }
    if (c === '&' && cur?.redirect) { add(c); continue; }
    if (c === '&' && src[i + 1] === '>') { cur ??= { text: '', redirect: true }; cur.redirect = true; add(c); continue; }
    if (SEPARATORS.has(c)) { endSegment(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue; }
    add(c);
  }
  endSegment();
  return { segments, nested };
}

interface Heredoc { delim: string; strip: boolean; expand: boolean }

/** If `src[i]` opens an arithmetic expression (`$((..))`, `$[..]`, or `((..))` in command position), return its body and the index of its last character. Unsure (no clean close) means undefined, so `<<` inside is then read as a plain operator. */
function arithAt(src: string, i: number, commandPos: boolean): { body: string; end: number; dollar: boolean } | undefined {
  const c = src[i];
  let from: number;
  let dollar = false;
  if (c === '$' && src[i + 1] === '[') {
    const e = src.indexOf(']', i + 2);
    return e < 0 ? undefined : { body: src.slice(i + 2, e), end: e, dollar: true };
  }
  if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') { from = i + 3; dollar = true; }
  else if (c === '(' && src[i + 1] === '(' && (commandPos || cmdPosBefore(src, i))) from = i + 2;
  else return undefined;
  let depth = 2;
  for (let k = from; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')' && --depth === 0) return src[k - 1] === ')' && k - 1 >= from ? { body: src.slice(from, k - 1), end: k, dollar } : undefined;
  }
  return undefined;
}

/** True when what precedes `src[i]` leaves it in command position (start, after a separator, or after a compound-command keyword such as `for`). */
function cmdPosBefore(src: string, i: number): boolean {
  return /(?:^|[;&|(\n{]|\b(?:for|while|until|if|then|do|else|elif))[ \t]*$/.test(src.slice(Math.max(0, i - 40), i));
}

/** Collect the `$(...)` and backtick substitutions in text a shell expands (an arithmetic body or an unquoted here-document body). */
function subsIn(text: string, nested: string[]): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && text[i + 1] === '(') { const e = closeParen(text, i + 2); nested.push(text.slice(i + 2, e)); i = e; continue; }
    if (c === '`') { const e = text.indexOf('`', i + 1); const end = e < 0 ? text.length : e; nested.push(text.slice(i + 1, end)); i = end; }
  }
}

/** If `src[i]` starts a here-document operator (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`; not `<<<`), return its delimiter. */
function heredocAt(src: string, i: number): Heredoc | undefined {
  if (src[i + 1] !== '<' || src[i + 2] === '<' || src[i - 1] === '<') return undefined;
  const m = /^<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|()<>'"\\])+)/.exec(src.slice(i, i + 300));
  if (!m) return undefined;
  const delim = m[2].replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_a, x, y, z) => x ?? y ?? z);
  return { delim, strip: m[1] === '-', expand: !/['"\\]/.test(m[2]) };
}

/** Index just past the bodies of the pending here-documents, which start at `from` (the line after the operator). An unterminated body runs to the end, as in a shell. */
function skipHeredocs(src: string, from: number, pending: Heredoc[], nested?: string[]): number {
  let i = from;
  for (const h of pending.splice(0)) {
    const bodyStart = i;
    let bodyEnd = i;
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const line = src.slice(i, nl < 0 ? src.length : nl);
      bodyEnd = i;
      i = nl < 0 ? src.length : nl + 1;
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      bodyEnd = i;
    }
    if (nested && h.expand) subsIn(src.slice(bodyStart, bodyEnd), nested);
  }
  return i;
}

function closeParen(s: string, from: number): number {
  let depth = 1;
  const heredocs: Heredoc[] = [];
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    const ar = arithAt(s, i, false);
    if (ar) { i = ar.end; continue; }
    if (c === '<') { const h = heredocAt(s, i); if (h) heredocs.push(h); }
    if (c === '\n' && heredocs.length) { i = skipHeredocs(s, i + 1, heredocs) - 1; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j; continue; }
    if (c === '"') { for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

/** Drop redirections (`>file`, `2>&1`, `> file`) from a word list. */
function stripRedirects(words: Word[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!words[i].redirect) { out.push(words[i].text); continue; }
    if (/^[\d&]*(>>?|<<?<?|>&|<&|&>>?)$/.test(words[i].text)) i++; // bare operator: the next word is its target
  }
  return out;
}

const WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'xargs', 'stdbuf', 'builtin', '{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'fi', 'done']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const isAssignment = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

// ───────────────────────────── analysis ─────────────────────────────

function analyse(src: string, cwd: string, ctx: GuardContext, reasons: string[], depth: number): void {
  if (depth > MAX_DEPTH) { reasons.push('shell nesting too deep to check'); return; }
  const { segments, nested } = split(src);
  let dir = cwd;
  for (const seg of segments) {
    const words = stripRedirects(seg);
    dir = commandIn(words, dir, ctx, reasons, depth);
  }
  for (const n of nested) analyse(n, dir, ctx, reasons, depth + 1);
}

/** Look at one command segment; returns the working directory for the segments after it (follows `cd`). */
function commandIn(words: string[], dir: string, ctx: GuardContext, reasons: string[], depth: number): string {
  let i = 0;
  while (i < words.length && isAssignment(words[i])) i++;
  const head = words[i];
  if (head === undefined) return dir;
  const name = basename(head);
  if (name === 'cd' || name === 'pushd') { const t = words[i + 1]; return t && t !== '-' && !t.startsWith('-') ? resolve(dir, t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : dir; }
  if (WRAPPERS.has(name)) {
    const j = words.findIndex((w, k) => k > i && (basename(w) === 'git' || SHELLS.has(basename(w)) || w === 'eval'));
    if (j > 0) commandIn(words.slice(j), dir, ctx, reasons, depth);
    return dir;
  }
  if (name === 'eval') { analyse(words.slice(i + 1).join(' '), dir, ctx, reasons, depth + 1); return dir; }
  if (SHELLS.has(name)) {
    const k = words.findIndex((w, idx) => idx > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    if (k > 0 && words[k + 1] !== undefined) analyse(words[k + 1], dir, ctx, reasons, depth + 1);
    return dir;
  }
  if (name === 'git') gitCommand(words.slice(i + 1), dir, ctx, reasons, depth);
  return dir;
}

interface Opts { flags: Set<string>; pos: string[] }

/** Sort words into flags (long names without `--`, single letters from clusters) and positionals; `takes` lists flags that consume a value. */
function opts(args: string[], takes: string[] = []): Opts {
  const flags = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1).map((p) => `--:${p}`)); flags.add('--'); break; }
    if (a.startsWith('--')) {
      const [n, v] = a.slice(2).split(/=(.*)/s);
      flags.add(n);
      if (v === undefined && takes.includes(n)) i++;
    } else if (/^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        flags.add(a[k]);
        if (takes.includes(a[k])) { if (k === a.length - 1) i++; break; }
      }
    } else pos.push(a);
  }
  return { flags, pos };
}
const has = (o: Opts, ...names: string[]): boolean => names.some((n) => o.flags.has(n));
const plain = (o: Opts): string[] => o.pos.map((p) => p.replace(/^--:/, ''));

export const isProtected = (ref: string): boolean => PROTECTED.includes(ref.replace(/^\+/, '').replace(/^(refs\/)?heads\//, ''));

function gitCommand(args: string[], startDir: string, ctx: GuardContext, reasons: string[], depth: number, inherited: string[] = []): void {
  let dir = startDir;
  const gitArgs: string[] = [...inherited];
  const inlineAliases: Record<string, string> = {};
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    const value = (): string => args[++i] ?? '';
    if (a === '-C') { dir = resolve(dir, value()); gitArgs.push('-C', dir); }
    else if (a === '-c') { const m = /^alias\.([^=]+)=(.*)$/s.exec(value()); if (m) inlineAliases[m[1]] = m[2]; }
    else if (a === '--git-dir' || a === '--work-tree') gitArgs.push(a, value());
    else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) gitArgs.push(a);
    else if (a === '--namespace' || a === '--super-prefix' || a === '--config-env') i++;
  }
  const verb = args[i];
  if (verb === undefined) return;
  const rest = args.slice(i + 1);
  const alias = inlineAliases[verb] ?? (KNOWN.has(verb) || READ_ONLY.has(verb) ? undefined : aliasOf(verb, dir, gitArgs, ctx));
  if (alias !== undefined) {
    if (alias.startsWith('!')) analyse(`${alias.slice(1)} ${rest.join(' ')}`, dir, ctx, reasons, depth + 1);
    else gitCommand([...alias.split(/\s+/).filter(Boolean), ...rest], dir, ctx, reasons, depth + 1, gitArgs);
    return;
  }
  const rule = RULES[verb];
  if (rule) rule(rest, { dir, gitArgs, ctx, reasons });
}

function aliasOf(verb: string, dir: string, gitArgs: string[], ctx: GuardContext): string | undefined {
  try { return ctx.aliases(dir, gitArgs)[verb]; } catch { return undefined; }
}

// ───────────────────────────── rules, one per verb ─────────────────────────────

interface Env { dir: string; gitArgs: string[]; ctx: GuardContext; reasons: string[] }
type Rule = (args: string[], env: Env) => void;

/** HEAD's branch: a name, '' (detached) or undefined (unreadable, which counts as protected, per the inconclusive-means-protected rule). */
function head(env: Env): string | undefined {
  try { return env.ctx.branch(env.dir, env.gitArgs); } catch { return undefined; }
}
function headIsProtected(env: Env): boolean | 'unknown' {
  const b = head(env);
  return b === undefined ? 'unknown' : isProtected(b);
}

const push: Rule = (args, env) => {
  const o = opts(args, ['repo', 'receive-pack', 'exec', 'push-option', 'o']);
  const force = ['force', 'f', 'force-with-lease', 'force-if-includes', 'mirror'].find((f) => o.flags.has(f));
  if (force) env.reasons.push(`git push with --${force.length === 1 ? 'force' : force} rewrites remote history`);
  if (has(o, 'all', 'mirror')) env.reasons.push('git push --all/--mirror pushes every branch, protected ones included');
  const p = plain(o);
  const refspecs = has(o, 'repo') ? p : p.slice(1);
  if (refspecs.some((r) => r.startsWith('+'))) env.reasons.push('git push +refspec is a force push');
  if (refspecs.length === 0) {
    if (has(o, 'tags') || has(o, 'all', 'mirror')) return;
    const h = headIsProtected(env);
    if (h === true) env.reasons.push(`git push with no refspec pushes the protected branch ${head(env)}`);
    else if (h === 'unknown') env.reasons.push('git push: could not tell which branch HEAD is on');
    return;
  }
  for (const r of refspecs) {
    const spec = r.replace(/^\+/, '');
    const dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
    if (dst.includes('*')) { env.reasons.push(`git push glob refspec ${r} may reach a protected branch`); continue; }
    if (/[$`{}]/.test(dst)) { env.reasons.push(`git push ${r}: the destination is built by the shell, so it cannot be shown to avoid a protected branch`); continue; }
    let target = dst;
    if (dst === 'HEAD' || dst === '@' || dst === '') {
      const b = head(env);
      if (b === undefined) { env.reasons.push('git push HEAD: could not tell which branch HEAD is on'); continue; }
      target = b;
    }
    if (isProtected(target)) env.reasons.push(`git push to protected branch ${target.replace(/^(refs\/)?heads\//, '')}`);
  }
};

const addRule: Rule = (args, env) => {
  const o = opts(args, ['pathspec-from-file', 'chmod']);
  if (has(o, 'A', 'all')) env.reasons.push('git add -A stages everything, untracked files included');
  if (plain(o).some((p) => ['.', './', ':/', '*', ':(top)'].includes(p))) env.reasons.push('git add . stages everything under the directory');
};

const commit: Rule = (args, env) => {
  const o = opts(args, ['m', 'F', 'C', 'c', 't', 'message', 'file', 'reuse-message', 'reedit-message', 'template', 'author', 'date', 'cleanup', 'fixup', 'squash', 'trailer']);
  if (has(o, 'a', 'all')) env.reasons.push('git commit -a stages every tracked change');
  const h = headIsProtected(env);
  if (h === true) env.reasons.push(`git commit while HEAD is the protected branch ${head(env)}`);
  else if (h === 'unknown') env.reasons.push('git commit: could not tell which branch HEAD is on');
};

const branch: Rule = (args, env) => {
  const o = opts(args, ['u', 'set-upstream-to', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format', 'abbrev', 'color', 'column', 'track']);
  const names = plain(o);
  if (has(o, 'D')) env.reasons.push('git branch -D deletes a branch even if unmerged');
  if ((has(o, 'delete') && has(o, 'force', 'f'))) env.reasons.push('git branch --delete --force deletes a branch even if unmerged');
  if (has(o, 'f', 'force', 'M') && !has(o, 'D')) env.reasons.push('git branch --force/-M moves or resets a branch');
  if (has(o, 'd', 'delete', 'm', 'M', 'f', 'force', 'D') && names.some(isProtected)) env.reasons.push('git branch changes a protected branch');
};

const clean: Rule = (args, env) => {
  const o = opts(args, ['e', 'exclude']);
  if (has(o, 'f', 'force') && !has(o, 'n', 'dry-run')) env.reasons.push('git clean -f deletes untracked files');
};

const checkout: Rule = (args, env) => {
  const o = opts(args, ['b', 'B', 'orphan', 'conflict', 'start-point']);
  const p = o.pos;
  const makesBranch = has(o, 'b', 'orphan') && !has(o, 'B');
  if (has(o, 'B')) env.reasons.push('git checkout -B resets a branch');
  if (has(o, 'f', 'force', 'ours', 'theirs', 'merge', 'm')) env.reasons.push('git checkout --force/--ours/--theirs can discard local changes');
  else if (!makesBranch && (o.flags.has('--') || p.some((x) => ['.', ':/'].includes(x)) || plain(o).length > 1)) env.reasons.push('git checkout of paths overwrites working-tree changes');
};

const restore: Rule = (args, env) => {
  const o = opts(args, ['s', 'source', 'pathspec-from-file']);
  const stagedOnly = has(o, 'S', 'staged') && !has(o, 'W', 'worktree');
  if (!stagedOnly) env.reasons.push('git restore overwrites working-tree changes');
};

const sw: Rule = (args, env) => {
  const o = opts(args, ['c', 'C', 'orphan', 'conflict', 't', 'track']);
  if (has(o, 'f', 'force', 'discard-changes', 'C', 'force-create')) env.reasons.push('git switch --force/-C discards changes or resets a branch');
};

const pull: Rule = (args, env) => {
  const o = opts(args, ['s', 'strategy', 'X', 'strategy-option', 'depth', 'deepen', 'upload-pack', 'o', 'j', 'jobs']);
  if (has(o, 'rebase', 'r')) env.reasons.push('git pull --rebase rewrites local commits');
  const p = plain(o);
  const h = head(env);
  if (p.slice(1).some((r) => isProtected(r.replace(/^\+/, '').split(':')[0]) && r.replace(/^\+/, '').split(':')[0] !== h)) env.reasons.push('git pull of a protected branch into another branch is a merge');
};

const ask = (why: string): Rule => (_a, env) => { env.reasons.push(why); };
const RULES: Record<string, Rule> = {
  push,
  reset: ask('git reset moves a branch and can discard changes'),
  rebase: ask('git rebase rewrites history'),
  merge: ask('git merge'),
  'cherry-pick': ask('git cherry-pick'),
  revert: ask('git revert'),
  add: addRule,
  commit,
  branch,
  clean,
  checkout,
  restore,
  switch: sw,
  pull,
};
const KNOWN = new Set(Object.keys(RULES));
const READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'fetch', 'ls-remote', 'rev-parse', 'blame', 'config', 'remote', 'stash', 'tag', 'worktree', 'ls-files', 'grep', 'describe', 'rev-list', 'cat-file']);

// ───────────────────────────── real git lookups ─────────────────────────────

function gitBranch(dir: string, gitArgs: string[]): string | '' | undefined {
  try {
    return execFileSync('git', [...gitArgs, 'symbolic-ref', '-q', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status === 1 ? '' : undefined; // 1: detached HEAD; anything else: not a repo / git missing / timeout
  }
}

function gitAliases(dir: string, gitArgs: string[]): Record<string, string> {
  try {
    const out = execFileSync('git', [...gitArgs, 'config', '--get-regexp', '^alias\\.'], { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const k = l.indexOf(' '); return [l.slice(0, k).replace(/^alias\./, ''), l.slice(k + 1)]; }));
  } catch { return {}; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = run(readFileSync(0, 'utf8'));
  if (out.stderr) process.stderr.write(out.stderr);
  if (out.stdout) process.stdout.write(`${out.stdout}\n`);
  process.exit(0);
}
