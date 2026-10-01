/**
 * LOCAL CONFIG: the one place the-maestro's scripts read install-specific values.
 *
 * Everything else in scripts/ is generic. Each value comes from, in order: its environment
 * variable, the user config file, then the org overlay's config.md. Where those files are
 * looked up is documented in reference/local-config.md ("How the scripts find it").
 *
 * `node scripts/local-config.mjs` prints the resolved values and the files they came from.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reads the `maestro-config` fenced block of a markdown file into { key: value }. */
export function parseConfig(text) {
  const block = text.match(/^```maestro-config[^\n]*\n([\s\S]*?)^```/m);
  const out = {};
  if (!block) return out;
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2').trim();
    if (value) out[m[1]] = value;
  }
  return out;
}

const readConfig = (path) => (path && existsSync(path) ? parseConfig(readFileSync(path, 'utf8')) : null);

/** The user file: MAESTRO_LOCAL_CONFIG (empty string disables all files), else ~/.config/the-maestro/config.md. */
function userConfigPath() {
  if (process.env.MAESTRO_LOCAL_CONFIG !== undefined) return process.env.MAESTRO_LOCAL_CONFIG;
  return join(homedir(), '.config', 'the-maestro', 'config.md');
}

/** Directories this skill can be reached through: as started (survives symlinks) and real. */
function skillRoots() {
  const roots = [join(dirname(fileURLToPath(import.meta.url)), '..')];
  if (process.argv[1]) roots.unshift(resolve(dirname(process.argv[1]), '..'));
  return [...new Set(roots.flatMap((r) => {
    try { return [r, realpathSync(r)]; } catch { return [r]; }
  }))];
}

/** Candidate config.md paths for an overlay named `<skill>` or `<plugin>:<skill>`. */
function overlayCandidates(overlay) {
  const [plugin, skill] = overlay.includes(':') ? overlay.split(/:(.*)/s) : [null, overlay];
  const out = [];
  if (plugin) {
    try {
      const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
      for (const [key, entries] of Object.entries(installed.plugins || {})) {
        if (key.split('@')[0] !== plugin) continue;
        for (const e of [].concat(entries)) if (e?.installPath) out.push(join(e.installPath, 'skills', skill, 'config.md'));
      }
    } catch { /* no plugin registry: fall through to the sibling lookup */ }
  }
  for (const root of skillRoots()) out.push(join(root, '..', skill, 'config.md'));
  out.push(join(homedir(), '.claude', 'skills', skill, 'config.md'));
  return out;
}

const userPath = userConfigPath();
const user = readConfig(userPath) || {};
const OVERLAY = process.env.MAESTRO_OVERLAY ?? user.overlay ?? '';
const overlayPath = OVERLAY ? overlayCandidates(OVERLAY).find((p) => existsSync(p)) || '' : '';
const overlay = readConfig(overlayPath) || {};

/** One setting: the environment variable if set (even empty), else the user file, else the overlay file. */
const pick = (envName, key, fallback = '') => process.env[envName] ?? user[key] ?? overlay[key] ?? fallback;

/** The config files that were read: the user file and the overlay's config.md (either may be empty). */
export { userPath, overlayPath };

/** Name of the org overlay skill (`<skill>` or `<plugin>:<skill>`); empty means none. */
export { OVERLAY };

/** GitHub org the PR board is scoped to. Unset or empty means no org filter. */
export const GH_ORG = pick('MAESTRO_GH_ORG', 'gh_org');

/** Your GitHub login. Unset means "whoever `gh` is authenticated as". */
export const GH_LOGIN = pick('MAESTRO_GH_LOGIN', 'gh_login');

/** The container directory's project name, used for ledger paths (Projects/<name>/Journal/). */
export const CONTAINER_PROJECT = pick('MAESTRO_PROJECT', 'project') || 'dev-env';

/**
 * Claude Code's transcript directory for the container, read by token-metrics.mjs. Claude Code
 * names it after the working directory with every path separator turned into a dash.
 */
export const CLAUDE_PROJECTS_DIR =
  pick('MAESTRO_PROJECTS_DIR', 'projects_dir') || join(homedir(), '.claude', 'projects', process.cwd().replace(/[\\/]/g, '-'));

/** Where the ledger's Journal/ lives. Empty means "not set": the scripts ask for --vault. */
export const LEDGER_ROOT = pick('LEDGER_ROOT', 'ledger_root');

/** The vault holding tickets, CONTEXT.md and the rest. Empty means "not set". */
export const VAULT_ROOT = pick('VAULT_ROOT', 'vault_root');

/** Process patterns `journal.mjs resume` checks with pgrep, comma-separated in the config. Empty means none. */
export const LOOP_PATTERNS = pick('MAESTRO_LOOP_PATTERNS', 'loop_patterns').split(',').map((s) => s.trim()).filter(Boolean);

/** Whether `journal.mjs resume` lists open PRs through `gh`. Anything but off/false/no/0 means on. */
export const RESUME_GH = !/^(off|false|no|0)$/i.test(pick('MAESTRO_RESUME_GH', 'resume_gh').trim());

/** Whether `journal.mjs roll` commits the ledger root after a clean `verify`. Off unless set to on/true/yes/1. */
export const LEDGER_GIT_AUTOCOMMIT = /^(on|true|yes|1)$/i.test(pick('MAESTRO_LEDGER_GIT_AUTOCOMMIT', 'ledger_git_autocommit').trim());

/** A positive integer setting; anything else (unset, zero, negative, text) falls back to the default. */
const positiveInt = (raw, fallback) => (/^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : fallback);

/** PR size budget (pr-size.mjs): most code files a PR may change. Default 5. */
export const PR_MAX_CODE_FILES = positiveInt(pick('MAESTRO_PR_MAX_CODE_FILES', 'pr_max_code_files'), 5);

/** PR size budget: most changed code lines (additions plus deletions). Default 400. */
export const PR_MAX_CODE_LINES = positiveInt(pick('MAESTRO_PR_MAX_CODE_LINES', 'pr_max_code_lines'), 400);

const globList = (envName, key) => pick(envName, key).split(',').map((s) => s.trim()).filter(Boolean);

/** Repos that use the integration/release-candidate twin-PR flow (git.md "Twin PRs"), comma-separated. Empty means the rule is off. */
export const TWIN_FLOW_REPOS = pick('MAESTRO_TWIN_FLOW_REPOS', 'twin_flow_repos').split(',').map((s) => s.trim()).filter(Boolean);

/** Path globs pr-size.mjs treats as tests / config / docs / mechanical. Empty means its built-in defaults. */
export const PR_TEST_GLOBS = globList('MAESTRO_PR_TEST_GLOBS', 'pr_test_globs');
export const PR_CONFIG_GLOBS = globList('MAESTRO_PR_CONFIG_GLOBS', 'pr_config_globs');
export const PR_DOCS_GLOBS = globList('MAESTRO_PR_DOCS_GLOBS', 'pr_docs_globs');
export const PR_MECHANICAL_GLOBS = globList('MAESTRO_PR_MECHANICAL_GLOBS', 'pr_mechanical_globs');

/** Your git author emails (comma-separated), the authorship check branch-sweep.mjs uses. Empty means the repo's own user.email. */
export const GIT_EMAILS = globList('MAESTRO_GIT_EMAILS', 'git_emails');

/** Branch names or globs (`*` within a path segment, `**` across them) branch-sweep.mjs never lists, besides each repo's merge targets and default branch. */
const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'staging', 'develop', 'release/*', 'staging/*', 'hotfix/*'];
export const PROTECTED_BRANCHES = globList('MAESTRO_PROTECTED_BRANCHES', 'protected_branches').length
  ? globList('MAESTRO_PROTECTED_BRANCHES', 'protected_branches') : DEFAULT_PROTECTED_BRANCHES;

/** Per-repo merge targets for branch-sweep.mjs, `repo=develop|staging, other=develop`. A repo not listed gets the default (develop, plus staging in twin-flow repos). */
export const SWEEP_MERGE_TARGETS = Object.fromEntries(globList('MAESTRO_SWEEP_MERGE_TARGETS', 'sweep_merge_targets')
  .map((e) => e.split('=')).filter(([r, t]) => r && t).map(([r, t]) => [r.trim(), t.split('|').map((b) => b.trim()).filter(Boolean)]));

/** Minutes a worktree must be untouched before branch-sweep.mjs offers it for removal. Default 60. */
export const SWEEP_IDLE_MINUTES = positiveInt(pick('MAESTRO_SWEEP_IDLE_MINUTES', 'sweep_idle_minutes'), 60);

/** How many days of merged PRs branch-sweep.mjs reads as evidence. An older merge reads as not merged. Default 180. */
export const SWEEP_PR_DAYS = positiveInt(pick('MAESTRO_SWEEP_PR_DAYS', 'sweep_pr_days'), 180);

/** Directories whose symlinks mark a worktree as a live skill, added to the defaults (~/.claude/skills and <container>/.claude/skills). */
export const SWEEP_PROTECT_SYMLINK_DIRS = globList('MAESTRO_SWEEP_PROTECT_SYMLINK_DIRS', 'sweep_protect_symlink_dirs');

/** Ignored paths a worktree may hold and still be removed (any path segment matching). Default node_modules, .venv, dist, __pycache__. Any other ignored file keeps the worktree. */
export const SWEEP_DISPOSABLE_IGNORED = globList('MAESTRO_SWEEP_DISPOSABLE_IGNORED', 'sweep_disposable_ignored').length
  ? globList('MAESTRO_SWEEP_DISPOSABLE_IGNORED', 'sweep_disposable_ignored') : ['node_modules', '.venv', 'dist', '__pycache__'];

/** The PR search string every PR script shares. */
export const PR_SEARCH = `is:pr is:open author:@me${GH_ORG ? ` org:${GH_ORG}` : ''}`;

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  console.log(`user_file:    ${userPath || '(disabled)'}${userPath && existsSync(userPath) ? '' : ' (not found)'}`);
  console.log(`overlay:      ${OVERLAY || '(none)'}`);
  console.log(`overlay_file: ${overlayPath || '(none found)'}`);
  for (const [k, v] of Object.entries({ GH_ORG, GH_LOGIN, CONTAINER_PROJECT, CLAUDE_PROJECTS_DIR, LEDGER_ROOT, VAULT_ROOT, LOOP_PATTERNS: LOOP_PATTERNS.join(', '), RESUME_GH: RESUME_GH ? 'on' : 'off', LEDGER_GIT_AUTOCOMMIT: LEDGER_GIT_AUTOCOMMIT ? 'on' : 'off', PR_MAX_CODE_FILES, PR_MAX_CODE_LINES, PR_TEST_GLOBS: PR_TEST_GLOBS.join(', '), PR_CONFIG_GLOBS: PR_CONFIG_GLOBS.join(', '), PR_DOCS_GLOBS: PR_DOCS_GLOBS.join(', '), PR_MECHANICAL_GLOBS: PR_MECHANICAL_GLOBS.join(', '), TWIN_FLOW_REPOS: TWIN_FLOW_REPOS.join(', '), GIT_EMAILS: GIT_EMAILS.join(', '), PROTECTED_BRANCHES: PROTECTED_BRANCHES.join(', '), SWEEP_MERGE_TARGETS: Object.entries(SWEEP_MERGE_TARGETS).map(([r, t]) => `${r}=${t.join('|')}`).join(', '), SWEEP_IDLE_MINUTES, SWEEP_PROTECT_SYMLINK_DIRS: SWEEP_PROTECT_SYMLINK_DIRS.join(', '), SWEEP_DISPOSABLE_IGNORED: SWEEP_DISPOSABLE_IGNORED.join(', ') })) {
    console.log(`${k.padEnd(22)} ${v || '(unset)'}`);
  }
}
