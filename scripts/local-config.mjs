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

const WEEKDAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

/**
 * Weekday the morning greeting brings the approvals digest (`journal.mjs approvals --days 7`), lowercase.
 * Default friday. A value that is not a weekday name falls back to the default.
 */
export const APPROVALS_REVIEW_DAY = ((day) => (WEEKDAYS.has(day) ? day : 'friday'))(pick('MAESTRO_APPROVALS_REVIEW_DAY', 'approvals_review_day').trim().toLowerCase());

/** Positive number from a config string, else the fallback. */
const positive = (text, fallback) => (Number(text) > 0 ? Number(text) : fallback);

/** Valid IANA time zone name, else undefined (the system zone). */
const validZone = (name) => {
  try { return name ? new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone : undefined; } catch { return undefined; }
};

/** Turns after which the status footer says "roll now" (cost/budget.md, session hygiene). Default 180. */
export const ROLL_TURNS = positive(pick('MAESTRO_ROLL_TURNS', 'roll_turns'), 180);

/** Cache-read tokens per turn at which the status footer says "roll now". A plain number, 350000 not 350k. Default 350000. */
export const ROLL_READ_PER_TURN = positive(pick('MAESTRO_ROLL_READ_PER_TURN', 'roll_read_per_turn'), 350000);

/** PR watcher: fastest poll in seconds. pr-watch.mjs never goes under 300 whatever this says. The event loop does not read it (see the per-type floors). */
export const WATCH_MIN_INTERVAL = positive(pick('MAESTRO_WATCH_MIN_INTERVAL', 'watch_min_interval'), 300);

/** PR watcher: slowest poll in seconds. */
export const WATCH_MAX_INTERVAL = positive(pick('MAESTRO_WATCH_MAX_INTERVAL', 'watch_max_interval'), 1800);

/** PR watcher quiet hours as `HH:MM-HH:MM` in WATCH_TZ; `off` disables them. */
export const WATCH_QUIET_HOURS = pick('MAESTRO_WATCH_QUIET_HOURS', 'watch_quiet_hours').trim() || '20:00-07:00';

/** What the watcher does in quiet hours: `stop` (exit) or `slow` (poll every 30 minutes). Default stop. */
export const WATCH_QUIET_HOURS_MODE = /^slow$/i.test(pick('MAESTRO_WATCH_QUIET_HOURS_MODE', 'watch_quiet_hours_mode').trim()) ? 'slow' : 'stop';

/** Whether Saturday and Sunday count as quiet hours too. Off unless set to on/true/yes/1. */
export const WATCH_QUIET_WEEKENDS = /^(on|true|yes|1)$/i.test(pick('MAESTRO_WATCH_QUIET_WEEKENDS', 'watch_quiet_weekends').trim());

/** IANA time zone the quiet hours are read in. Unset or invalid means the system time zone. */
export const WATCH_TZ = validZone(pick('MAESTRO_WATCH_TZ', 'watch_tz').trim()) || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Event loop: network watch types (GitHub) never run more often than this many seconds. A lower value is ignored; 120 is the hard floor. */
export const WATCH_NETWORK_FLOOR = Math.max(120, positive(pick('MAESTRO_WATCH_NETWORK_FLOOR', 'watch_network_floor'), 120));

/** Event loop: local watch types (inbox, reminder) never run more often than this many seconds. A lower value is ignored; 30 is the hard floor. */
export const WATCH_LOCAL_FLOOR = Math.max(30, positive(pick('MAESTRO_WATCH_LOCAL_FLOOR', 'watch_local_floor'), 30));

/** Event loop: default interval per type in seconds, `pr-checks=240, inbox=90`. An entry that is not a positive number is dropped. The floors still apply. */
export const WATCH_TYPE_INTERVALS = Object.fromEntries(pick('MAESTRO_WATCH_TYPE_INTERVALS', 'watch_type_intervals').split(',')
  .map((e) => e.split('=').map((x) => x.trim())).filter(([t, n]) => t && Number.isFinite(Number(n)) && Number(n) > 0).map(([t, n]) => [t, Number(n)]));

/** A command as an argv array: a JSON array of strings in the config (`["tool", "--flag"]`). Anything else is none. */
const argvList = (text) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x) ? v : [];
  } catch { return []; }
};

/** Event loop: where the watch registry, state and digest live. Default `<ledger_root>/Events`, else ~/.local/state/the-maestro/events. */
export const EVENT_DIR = pick('MAESTRO_EVENT_DIR', 'event_dir') || (LEDGER_ROOT ? join(LEDGER_ROOT, 'Events') : join(homedir(), '.local', 'state', 'the-maestro', 'events'));

/** Event loop notifier: argv whose last argument is the one-line summary. Empty means no notifications. */
export const NOTIFY_COMMAND = argvList(pick('MAESTRO_NOTIFY_COMMAND', 'notify_command'));

/** Event loop `inbox` type: argv printing one line per unread message. It must not mark them read. Empty means the type reports nothing. */
export const INBOX_COMMAND = argvList(pick('MAESTRO_INBOX_COMMAND', 'inbox_command'));

/** A positive integer setting; anything else (unset, zero, negative, text) falls back to the default. */
const positiveInt = (raw, fallback) => (/^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : fallback);

/** Pattern for tracker keys (ABC-123) in a PR title or branch, used by the pr-merged event type. Generic by default; an overlay narrows it (for one project, `\bAH-\d+\b`). An invalid pattern falls back to the default. */
const DEFAULT_TRACKER_KEY_PATTERN = '\\b[A-Z][A-Z0-9]+-\\d+\\b';
export const TRACKER_KEY_PATTERN = ((raw) => { try { new RegExp(raw); return raw; } catch { return DEFAULT_TRACKER_KEY_PATTERN; } })(pick('MAESTRO_TRACKER_KEY_PATTERN', 'tracker_key_pattern').trim() || DEFAULT_TRACKER_KEY_PATTERN);

/** PR size budget (pr-size.mjs): most code files a PR may change. Default 5. */
export const PR_MAX_CODE_FILES = positiveInt(pick('MAESTRO_PR_MAX_CODE_FILES', 'pr_max_code_files'), 5);

/** PR size budget: most changed code lines (additions plus deletions). Default 400. */
export const PR_MAX_CODE_LINES = positiveInt(pick('MAESTRO_PR_MAX_CODE_LINES', 'pr_max_code_lines'), 400);

const globList = (envName, key) => pick(envName, key).split(',').map((s) => s.trim()).filter(Boolean);

/** Repos that use the integration/release-candidate twin-PR flow (git.md "Twin PRs"), comma-separated. Empty means the rule is off. */
export const TWIN_FLOW_REPOS = pick('MAESTRO_TWIN_FLOW_REPOS', 'twin_flow_repos').split(',').map((s) => s.trim()).filter(Boolean);

/** Owners (orgs or users, comma-separated) whose draft PRs pr-watch.mjs requests Copilot review on. Empty means nowhere. */
export const COPILOT_ORGS = globList('MAESTRO_COPILOT_ORGS', 'copilot_orgs');

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

/** Seconds the worktree sweep may run; once over, it stops at the next repo boundary and reports the repos it skipped. Default 300. */
export const SWEEP_BUDGET_SECONDS = positiveInt(pick('MAESTRO_SWEEP_BUDGET_SECONDS', 'sweep_budget_seconds'), 300);

/** How many days of merged PRs branch-sweep.mjs reads as evidence. An older merge reads as not merged. Default 180. */
export const SWEEP_PR_DAYS = positiveInt(pick('MAESTRO_SWEEP_PR_DAYS', 'sweep_pr_days'), 180);

/** Directories whose symlinks mark a worktree as a live skill, added to the defaults (~/.claude/skills and <container>/.claude/skills). */
export const SWEEP_PROTECT_SYMLINK_DIRS = globList('MAESTRO_SWEEP_PROTECT_SYMLINK_DIRS', 'sweep_protect_symlink_dirs');

/** Ignored paths a worktree may hold and still be removed (any path segment matching). Default node_modules, .venv, dist, __pycache__. Any other ignored file keeps the worktree. */
export const SWEEP_DISPOSABLE_IGNORED = globList('MAESTRO_SWEEP_DISPOSABLE_IGNORED', 'sweep_disposable_ignored').length
  ? globList('MAESTRO_SWEEP_DISPOSABLE_IGNORED', 'sweep_disposable_ignored') : ['node_modules', '.venv', 'dist', '__pycache__'];

/** A shared scripts shelf (`<dir>/README.md` index, `<dir>/scratch/`, `<dir>/helpers/`). Unset means the feature is off. A leading `~/` is expanded. */
export const SCRIPTS_SHELF_DIR = ((v) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))(pick('MAESTRO_SCRIPTS_DIR', 'scripts_dir').trim());

/** The container root the roll's worktree sweep is allowed to scan. Unset means the sweep refuses. A leading `~/` is expanded. */
/** Repo paths the agent manages itself (comma-separated, a leading ~/ expanded). The protected-branch stop does not apply there: agents may commit straight to the default branch. Empty means none. */
export const AGENT_OWNED_REPOS = globList('MAESTRO_AGENT_OWNED_REPOS', 'agent_owned_repos').map((v) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v));

export const CONTAINER_ROOT = ((v) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))(pick('MAESTRO_CONTAINER_ROOT', 'container_root').trim());

/** The PR search string every PR script shares. */
export const PR_SEARCH = `is:pr is:open author:@me${GH_ORG ? ` org:${GH_ORG}` : ''}`;

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  console.log(`user_file:    ${userPath || '(disabled)'}${userPath && existsSync(userPath) ? '' : ' (not found)'}`);
  console.log(`overlay:      ${OVERLAY || '(none)'}`);
  console.log(`overlay_file: ${overlayPath || '(none found)'}`);
  for (const [k, v] of Object.entries({ GH_ORG, GH_LOGIN, CONTAINER_PROJECT, CLAUDE_PROJECTS_DIR, ROLL_TURNS, ROLL_READ_PER_TURN, LEDGER_ROOT, VAULT_ROOT, LOOP_PATTERNS: LOOP_PATTERNS.join(', '), RESUME_GH: RESUME_GH ? 'on' : 'off', LEDGER_GIT_AUTOCOMMIT: LEDGER_GIT_AUTOCOMMIT ? 'on' : 'off', PR_MAX_CODE_FILES, PR_MAX_CODE_LINES, PR_TEST_GLOBS: PR_TEST_GLOBS.join(', '), PR_CONFIG_GLOBS: PR_CONFIG_GLOBS.join(', '), PR_DOCS_GLOBS: PR_DOCS_GLOBS.join(', '), PR_MECHANICAL_GLOBS: PR_MECHANICAL_GLOBS.join(', '), TWIN_FLOW_REPOS: TWIN_FLOW_REPOS.join(', '), COPILOT_ORGS: COPILOT_ORGS.join(', '), GIT_EMAILS: GIT_EMAILS.join(', '), PROTECTED_BRANCHES: PROTECTED_BRANCHES.join(', '), SWEEP_MERGE_TARGETS: Object.entries(SWEEP_MERGE_TARGETS).map(([r, t]) => `${r}=${t.join('|')}`).join(', '), SWEEP_IDLE_MINUTES, SWEEP_BUDGET_SECONDS, TRACKER_KEY_PATTERN, SWEEP_PROTECT_SYMLINK_DIRS: SWEEP_PROTECT_SYMLINK_DIRS.join(', '), SWEEP_DISPOSABLE_IGNORED: SWEEP_DISPOSABLE_IGNORED.join(', '), APPROVALS_REVIEW_DAY, WATCH_MIN_INTERVAL, WATCH_MAX_INTERVAL, WATCH_NETWORK_FLOOR, WATCH_LOCAL_FLOOR, WATCH_TYPE_INTERVALS: Object.entries(WATCH_TYPE_INTERVALS).map(([t, n]) => `${t}=${n}`).join(', '), WATCH_QUIET_HOURS, WATCH_QUIET_HOURS_MODE, WATCH_QUIET_WEEKENDS: WATCH_QUIET_WEEKENDS ? 'on' : 'off', WATCH_TZ, EVENT_DIR, NOTIFY_COMMAND: NOTIFY_COMMAND.length ? '(set)' : '', INBOX_COMMAND: INBOX_COMMAND.length ? '(set)' : '', SCRIPTS_DIR: SCRIPTS_SHELF_DIR, AGENT_OWNED_REPOS: AGENT_OWNED_REPOS.join(', '), CONTAINER_ROOT })) {
    console.log(`${k.padEnd(22)} ${v || '(unset)'}`);
  }
}
