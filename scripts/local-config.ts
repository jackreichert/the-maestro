/**
 * LOCAL CONFIG: the one place the-maestro's scripts read install-specific values.
 *
 * Everything else in scripts/ is generic. Each value comes from, in order: its environment
 * variable, the user config file, then the org overlay's config.md — except the pr-open gate
 * settings (the size file and line limits, including the wide tier, waive_size_gate_owners,
 * pr_smells_repos, the required body sections, the body-check on/off switches, and the
 * body-check lists pr_body_private_words, pr_body_private_patterns, pr_body_voice_names). Those
 * are read from the user config file only, so an environment variable cannot lift them. Where
 * the files are looked up is documented in reference/local-config.md ("How the scripts find it").
 *
 * `node scripts/local-config.ts` prints the resolved values and the files they came from.
 */
import { checkWindow, logProblem, parseClock, parseDays, parseInt10, parseRepos, parseSwitch, parseTriggers, parseZone } from './lib/repost-nudge-config.ts';
import type { Parsed } from './lib/repost-nudge-config.ts';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_PRIORITIES_MAX } from './lib/status-page/priorities.ts';
import { DEFAULT_STALE_WIP_DAYS } from './lib/journal/staleness.ts';
import { fileURLToPath } from 'node:url';

/** Reads the `maestro-config` fenced block of a markdown file into { key: value }. */
export function parseConfig(text: string): Record<string, string> {
  const block = text.match(/^```maestro-config[^\n]*\n([\s\S]*?)^```/m);
  const out: Record<string, string> = {};
  if (!block) return out;
  for (const line of (block[1] ?? '').split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const value = (m[2] ?? '').replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2').trim();
    if (value) out[m[1] as string] = value;
  }
  return out;
}

const readConfig = (path: string | undefined): Record<string, string> | null => (path && existsSync(path) ? parseConfig(readFileSync(path, 'utf8')) : null);

/** The user file: MAESTRO_LOCAL_CONFIG (empty string disables all files), else ~/.config/the-maestro/config.md. */
function userConfigPath(): string {
  if (process.env.MAESTRO_LOCAL_CONFIG !== undefined) return process.env.MAESTRO_LOCAL_CONFIG;
  return join(homedir(), '.config', 'the-maestro', 'config.md');
}

/** Directories this skill can be reached through: as started (survives symlinks) and real. */
function skillRoots(): string[] {
  const roots = [join(dirname(fileURLToPath(import.meta.url)), '..')];
  if (process.argv[1]) roots.unshift(resolve(dirname(process.argv[1]), '..'));
  return [...new Set(roots.flatMap((r) => {
    try { return [r, realpathSync(r)]; } catch { return [r]; }
  }))];
}

/** True when `dir` belongs to the current user (or root) and neither its group nor others can write it. */
function ownedAndPrivate(dir: string): boolean {
  try { const st = statSync(dir); return (st.uid === process.getuid?.() || st.uid === 0) && (st.mode & 0o022) === 0; } catch { return false; }
}

/**
 * True when `file` can be trusted to name commands: its real path (symlinks resolved) sits in a directory, and under ancestors
 * all the way to the root, that the current user (or root) owns and neither group nor others can write.
 */
export function trustedConfigFile(file: string): boolean {
  let real: string;
  try { real = realpathSync(file); } catch { return false; }
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (!ownedAndPrivate(dir)) return false;
    if (dirname(dir) === dir) return true;
  }
}

/** Candidate config.md paths for an overlay named `<skill>` or `<plugin>:<skill>`. */
function overlayCandidates(overlay: string): string[] {
  const [plugin, skill = ''] = overlay.includes(':') ? overlay.split(/:(.*)/s) : [null, overlay];
  const out: string[] = [];
  if (plugin) {
    try {
      const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, { installPath?: string } | { installPath?: string }[]> };
      for (const [key, entries] of Object.entries(installed.plugins || {})) {
        if (key.split('@')[0] !== plugin) continue;
        for (const e of Array.isArray(entries) ? entries : [entries]) if (e?.installPath) out.push(join(e.installPath, 'skills', skill, 'config.md'));
      }
    } catch { /* no plugin registry: fall through to the sibling lookup */ }
  }
  for (const root of skillRoots()) out.push(join(root, '..', skill, 'config.md'));
  // A checkout reached by its real path (no symlink in ~/.claude/skills) still sits under a container whose .claude/skills holds the overlay.
  // The overlay can name commands, so a config found this way is used only when trustedConfigFile accepts where it really lives.
  for (const root of skillRoots()) for (let dir = dirname(root); dirname(dir) !== dir; dir = dirname(dir)) {
    const candidate = join(dir, '.claude', 'skills', skill, 'config.md');
    if (trustedConfigFile(candidate)) out.push(candidate);
  }
  out.push(join(homedir(), '.claude', 'skills', skill, 'config.md'));
  return out;
}

const userPath = userConfigPath();
const user = readConfig(userPath) || {};
const OVERLAY = process.env.MAESTRO_OVERLAY ?? user.overlay ?? '';
const overlayPath = OVERLAY ? overlayCandidates(OVERLAY).find((p) => existsSync(p)) || '' : '';
const overlay = readConfig(overlayPath) || {};

/** One setting: the environment variable if set (even empty), else the user file, else the overlay file. */
const pick = (envName: string, key: string, fallback = ''): string => {
  const value = process.env[envName] ?? user[key] ?? overlay[key] ?? fallback;
  picked.set(key, { key, envName, value, source: process.env[envName] !== undefined ? `env ${envName}` : user[key] !== undefined ? userPath : overlay[key] !== undefined ? overlayPath : 'default' });
  return value;
};

/** A pr-open gate setting: the user config file only. The environment and the overlay file are ignored, so neither can lift the gate. */
const pickUserFile = (key: string, fallback = ''): string => {
  const value = user[key] ?? fallback;
  picked.set(key, { key, envName: '', value, source: user[key] !== undefined ? userPath : 'default' });
  return value;
};

/** One setting as resolved: its config key, environment variable (empty for user-file-only gate settings), raw value and where the value came from. */
export interface ResolvedSetting { key: string; envName: string; value: string; source: string }
const picked = new Map<string, ResolvedSetting>();
/** `overlay` is resolved before `pick` exists and can only come from the environment or the user file (never from the overlay it names), so it is recorded here. */
picked.set('overlay', { key: 'overlay', envName: 'MAESTRO_OVERLAY', value: OVERLAY, source: process.env.MAESTRO_OVERLAY !== undefined ? 'env MAESTRO_OVERLAY' : user.overlay !== undefined ? userPath : 'default' });

/** Every setting this process resolved, sorted by key, with the file or environment variable each value came from. `default` means no source set it. */
export const resolvedSettings = (): ResolvedSetting[] => [...picked.values()].sort((a, b) => a.key.localeCompare(b.key));

/** The config files that were read: the user file and the overlay's config.md (either may be empty). */
export { userPath, overlayPath };

/** Name of the org overlay skill (`<skill>` or `<plugin>:<skill>`); empty means none. */
export { OVERLAY };

/** GitHub org the PR board is scoped to. Unset or empty means no org filter. */
export const GH_ORG = pick('MAESTRO_GH_ORG', 'gh_org');

/** A prefix your repos share (`acme-`), so queue-report reads `tool #5` in a ledger row as the repo `acme-tool` when that checkout exists. Unset means a bare name is only ever itself. */
export const REPO_PREFIX = pick('MAESTRO_REPO_PREFIX', 'repo_prefix').trim();

/** Your GitHub login. Unset means "whoever `gh` is authenticated as". */
export const GH_LOGIN = pick('MAESTRO_GH_LOGIN', 'gh_login');

/** The `project` setting as configured (environment, user file or overlay), empty when none sets it. journal.ts uses this as its `--project` default. */
export const CONFIGURED_PROJECT = pick('MAESTRO_PROJECT', 'project');

/** The container directory's project name, used for ledger paths (Projects/<name>/Journal/). */
export const CONTAINER_PROJECT = CONFIGURED_PROJECT || 'dev-env';

/** The container directory the orchestrator runs in, `~/` expanded; empty when unset. */
const PROJECTS_ROOT = pick('MAESTRO_CONTAINER_ROOT', 'container_root').trim().replace(/^~(?=\/)/, homedir());

/**
 * Claude Code's transcript directory for the container, read by token-metrics.ts. Claude Code names it after the
 * session's working directory with every path separator turned into a dash. Unset, the directory is the one for
 * `container_root` when that is set (the orchestrator runs there), else for the working directory of the script,
 * which is the wrong folder whenever the script runs from somewhere else.
 */
export const CLAUDE_PROJECTS_DIR =
  pick('MAESTRO_PROJECTS_DIR', 'projects_dir')
  || join(homedir(), '.claude', 'projects', (PROJECTS_ROOT || process.cwd()).replace(/[\\/]/g, '-'));

/** True when neither `projects_dir` nor `container_root` is set, so CLAUDE_PROJECTS_DIR is only a guess from the working directory. */
export const PROJECTS_DIR_GUESSED = !pick('MAESTRO_PROJECTS_DIR', 'projects_dir') && !PROJECTS_ROOT;

/** Expands a leading `~/`. */
const expandHome = (v: string): string => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v);

/** Where the ledger's Journal/ lives. Empty means "not set": the scripts ask for --vault. */
export const LEDGER_ROOT = expandHome(pick('LEDGER_ROOT', 'ledger_root').trim());

/** Atlassian tenant hosts the Podium may reuse a tab for (comma-separated `<label>.atlassian.net`). Empty means none: every ticket link opens a fresh tab. */
export const PODIUM_TRUSTED_ATLASSIAN_HOSTS = pick('PODIUM_TRUSTED_ATLASSIAN_HOSTS', 'podium_trusted_atlassian_hosts').split(',').map((s) => s.trim()).filter(Boolean);

/** Fixed Podium colours for streams: `Name=s1, Other=s2` (classes s1..s8 or so). Entries that are not `name=class` with a known class are dropped; empty means none, and every other stream gets a hashed colour. */
export function parseSeries(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const [name, cls, ...rest] = entry.split('=').map((s) => s.trim());
    if (name && cls && rest.length === 0 && /^s(?:[1-8]|o)$/.test(cls)) out[name] = cls;
  }
  return out;
}
export const PODIUM_SERIES = parseSeries(pick('PODIUM_SERIES', 'podium_series'));

/** The vault holding tickets, CONTEXT.md and the rest. Empty means "not set". */
export const VAULT_ROOT = expandHome(pick('VAULT_ROOT', 'vault_root').trim());

/** Process patterns `journal.ts resume` checks with pgrep, comma-separated in the config. Empty means none. */
export const LOOP_PATTERNS = pick('MAESTRO_LOOP_PATTERNS', 'loop_patterns').split(',').map((s) => s.trim()).filter(Boolean);

/** Whether `journal.ts resume` lists open PRs through `gh`. Anything but off/false/no/0 means on. */
export const RESUME_GH = !/^(off|false|no|0)$/i.test(pick('MAESTRO_RESUME_GH', 'resume_gh').trim());

/** How far back the roll and the `notes-reachable` row look for unreachable notes: `30d` (days back) or `YYYY-MM-DD` (a start date). `all` looks at every note. Older notes are left alone until they are touched. Default 7d. */
export const NOTES_CHECK_SINCE = pick('MAESTRO_NOTES_CHECK_SINCE', 'notes_check_since').trim() || '7d';

/** Whether `journal.ts roll` commits the ledger root after a clean `verify`. Off unless set to on/true/yes/1. */
export const LEDGER_GIT_AUTOCOMMIT = /^(on|true|yes|1)$/i.test(pick('MAESTRO_LEDGER_GIT_AUTOCOMMIT', 'ledger_git_autocommit').trim());

/** Whether `prime` fetches this skill's own repo and reports when it is behind, ahead, diverged or dirty. On by default; `off`, `false`, `no` or `0` skips it (and the fetch). */
export const UPDATE_CHECK = !/^(off|false|no|0)$/i.test(pick('MAESTRO_UPDATE_CHECK', 'update_check').trim());

/** Whether a missing supervisor is a fault: `required` makes the `Loop:` line say NOT INSTALLED (or DOWN) loudly instead of staying silent. Off by default. */
export const LOOP_SUPERVISOR_REQUIRED = /^(required|on|true|yes|1)$/i.test(pick('MAESTRO_LOOP_SUPERVISOR', 'loop_supervisor').trim());

/** Whether `prime` fast-forwards a clean, purely-behind skill checkout (`git merge --ff-only` only). Off by default. */
export const AUTO_PULL = /^(on|true|yes|1)$/i.test(pick('MAESTRO_AUTO_PULL', 'auto_pull').trim());

/**
 * Whether auto_pull was answered anywhere (environment, user file or overlay) with a recognised on/off word. Unset is not
 * the same as off: `prime` asks about an unset auto_pull and stays quiet once it is on or off. AUTO_PULL itself is unchanged.
 */
export const AUTO_PULL_SET = /^(on|true|yes|1|off|false|no|0)$/i.test(pick('MAESTRO_AUTO_PULL', 'auto_pull').trim());

const WEEKDAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

/**
 * Weekday the morning greeting brings the approvals digest (`journal.ts approvals --days 7`), lowercase.
 * Default friday. A value that is not a weekday name falls back to the default.
 */
export const APPROVALS_REVIEW_DAY = ((day: string) => (WEEKDAYS.has(day) ? day : 'friday'))(pick('MAESTRO_APPROVALS_REVIEW_DAY', 'approvals_review_day').trim().toLowerCase());

/** Positive number from a config string, else the fallback. */
const positive = (text: string, fallback: number): number => (Number(text) > 0 ? Number(text) : fallback);

/** Days an in-flight item may sit with no live lease before the board, footer, `status --json` and `triage` call it stale. Default 3 (DEFAULT_STALE_WIP_DAYS). */
export const STALE_WIP_DAYS = positive(pick('MAESTRO_STALE_WIP_DAYS', 'stale_wip_days'), DEFAULT_STALE_WIP_DAYS);

/** Valid IANA time zone name, else undefined (the system zone). */
const validZone = (name: string): string | undefined => {
  try { return name ? new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone : undefined; } catch { return undefined; }
};

/**
 * A map of positive numbers from a config string: `opus=1, sonnet=0.2`, `opus: 1, sonnet: 0.2` or `{opus: 1, "sonnet": 0.2}`.
 * An entry that is not `name, separator, positive number` is dropped.
 */
export function numberMap(text: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of String(text || '').replace(/[{}"']/g, '').split(',')) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*[=:]\s*(\d+(?:\.\d+)?)\s*$/.exec(entry);
    if (m && Number(m[2]) > 0) out[m[1] as string] = Number(m[2]);
  }
  return out;
}

/**
 * Cost targets token-metrics.ts scores each day against. Shares are percent of tokens (40 means 40%), the rest plain numbers.
 * `opus_share_max` and `haiku_share_min` apply to the cache-read model mix; `opus_priced_share_max` applies to the share of
 * estimated dollars and only scores once `model_prices` is set. There is no Haiku priced target: Haiku is cheap by design.
 */
export const DEFAULT_COST_TARGETS = {
  opus_share_max: 40, haiku_share_min: 15, opus_priced_share_max: 50, wakes_per_prompt_max: 0.5, read_per_turn_max: 200000, turns_since_compact_max: 150,
};
export const COST_TARGETS = { ...DEFAULT_COST_TARGETS, ...numberMap(pick('MAESTRO_COST_TARGETS', 'cost_targets')) };

/** The price fields a model family needs, in dollars per million tokens. `cache_write_1h` is optional and falls back to `cache_write_5m`. */
export const PRICE_FIELDS = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'] as const;
export type PriceField = typeof PRICE_FIELDS[number];
/** Dollars per million tokens for one model family. */
export type ModelPrice = Record<PriceField, number>;
const REQUIRED_PRICE_FIELDS = PRICE_FIELDS.filter((f) => f !== 'cache_write_1h');

/**
 * Dollars per million tokens by model family, from a config string of `;`-separated groups:
 * `opus: input=4, cache_write_5m=5, cache_write_1h=8, cache_read=0.2, output=20; sonnet: ...`.
 * A family counts only with input, cache_write_5m, cache_read and output; one missing a field is dropped.
 */
export function parseModelPrices(text: unknown): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const group of String(text || '').replace(/[{}"']/g, '').split(';')) {
    const m = /^\s*([a-z]+)\s*:(.*)$/s.exec(group);
    if (!m) continue;
    const fields = numberMap(m[2]);
    if (!REQUIRED_PRICE_FIELDS.every((f) => fields[f])) continue;
    out[m[1] as string] = Object.fromEntries(PRICE_FIELDS.map((f) => [f, fields[f] ?? fields.cache_write_5m])) as ModelPrice;
  }
  return out;
}

/**
 * Prices per model family for the dollar estimates in token-metrics.ts. Only a complete opus, sonnet and haiku set counts; anything
 * less is null and the output shows the token mix alone. `other` (any other family) is optional. No prices are built in: the
 * current Anthropic list is documented in the README to paste into your config.
 */
export const MODEL_PRICES = ((p: Record<string, ModelPrice>) => (p.opus && p.sonnet && p.haiku ? p : null))(parseModelPrices(pick('MAESTRO_MODEL_PRICES', 'model_prices')));

/** Lowest autocompact trigger, in tokens, that the setting check accepts without a warning. Default 100000: a trigger near the ~50-60k post-compaction base compacts every minute or two. */
export const AUTOCOMPACT_FLOOR = positive(pick('MAESTRO_AUTOCOMPACT_FLOOR', 'autocompact_floor'), 100000);

/** Claude Code's settings file; only its `env` autocompact keys are ever read (scripts/lib/autocompact.ts). Tests point it at a temp file. */
export const CLAUDE_SETTINGS_PATH = expandHome(pick('MAESTRO_CLAUDE_SETTINGS', 'claude_settings').trim() || '~/.claude/settings.json');

/** Integer percent in 1..100 from a config string, else the fallback. */
const percent = (text: string, fallback: number): number => (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 100 ? Number(text) : fallback);

/**
 * The Session line's graded thresholds, as a percent of the autocompact trigger (the last turn's context over the trigger in lib/autocompact.ts): `roll soon` from
 * roll_warn_pct (default 60), `roll now` from roll_at_pct (default 90). A pair with warn >= roll is rejected
 * as a pair: both fall back to the defaults, since neither value can be trusted to be the intended one.
 */
export const [ROLL_WARN_PCT, ROLL_AT_PCT] = ((warn: number, at: number): [number, number] => (warn < at ? [warn, at] : [60, 90]))(
  percent(pick('MAESTRO_ROLL_WARN_PCT', 'roll_warn_pct'), 60),
  percent(pick('MAESTRO_ROLL_AT_PCT', 'roll_at_pct'), 90),
);

/** PR watcher: fastest poll in seconds, never under 300 whatever this says. The event loop's per-type floors (watch_network_floor, watch_local_floor) are separate. */
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
const argvList = (text: string): string[] => {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x) ? (v as string[]) : [];
  } catch { return []; }
};

/** Event loop: where the watch registry, state and digest live. Default `<ledger_root>/Events`, else ~/.local/state/the-maestro/events. */
export const EVENT_DIR = pick('MAESTRO_EVENT_DIR', 'event_dir') || (LEDGER_ROOT ? join(LEDGER_ROOT, 'Events') : join(homedir(), '.local', 'state', 'the-maestro', 'events'));

/** Event loop notifier: argv whose last argument is the one-line summary. Empty means no notifications. */
export const NOTIFY_COMMAND = argvList(pick('MAESTRO_NOTIFY_COMMAND', 'notify_command'));

/**
 * Event loop session launcher: argv run by the loop supervisor when an actionable event has waited with no session listening
 * (lib/session-wake.ts). The fixed wake prompt is appended as its last argument. Empty means launching is off, the default: each install opts in.
 * On macOS, `["node", "/path/to/scripts/wake-terminal.ts"]`.
 */
export const WAKE_LAUNCH_COMMAND = argvList(pick('MAESTRO_WAKE_LAUNCH_COMMAND', 'wake_launch_command'));

/** Event loop `inbox` type: argv printing one line per unread message. It must not mark them read. Empty means the type reports nothing. */
export const INBOX_COMMAND = argvList(pick('MAESTRO_INBOX_COMMAND', 'inbox_command'));

/** Jira freeze guard: argv that prints one label per line for the issue key appended as its last argument. Empty means labels cannot be read, so the guard fails closed. */
export const JIRA_LABELS_COMMAND = argvList(pick('MAESTRO_JIRA_LABELS_COMMAND', 'jira_labels_command'));

/** A positive integer setting; anything else (unset, zero, negative, text) falls back to the default. */
const positiveInt = (raw: string, fallback: number): number => (/^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : fallback);

/** Pattern for tracker keys (ABC-123) in a PR title or branch, used by the pr-merged event type. Generic by default; an overlay narrows it (for one project, `\bAV-\d+\b`). An invalid pattern falls back to the default. */
const DEFAULT_TRACKER_KEY_PATTERN = '\\b[A-Z][A-Z0-9]+-\\d+\\b';
export const TRACKER_KEY_PATTERN = ((raw: string) => { try { new RegExp(raw); return raw; } catch { return DEFAULT_TRACKER_KEY_PATTERN; } })(pick('MAESTRO_TRACKER_KEY_PATTERN', 'tracker_key_pattern').trim() || DEFAULT_TRACKER_KEY_PATTERN);

/** Key prefixes that belong to no tracker (the local MAESTRO-N / MITHRIL-N keys of personal repos): a done item carrying one is never a pending transition. Comma-separated; default MAESTRO,MITHRIL; `none` clears it. */
export const LOCAL_KEY_PREFIXES: string[] = (() => {
  const raw = pick('MAESTRO_LOCAL_KEY_PREFIXES', 'local_key_prefixes').trim();
  if (raw.toLowerCase() === 'none') return [];
  const list = raw.split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z][A-Z0-9]*$/.test(x));
  return list.length ? list : ['MAESTRO', 'MITHRIL'];
})();

/** PR size budget (pr-size.ts): most code files a PR may change. Default 5. User config file only. */
export const PR_MAX_CODE_FILES = positiveInt(pickUserFile('pr_max_code_files'), 5);

/** PR size budget: most changed code lines (additions plus deletions). Default 400. User config file only. */
export const PR_MAX_CODE_LINES = positiveInt(pickUserFile('pr_max_code_lines'), 400);

/** PR size budget, wide tier (opt-in): most code files a PR may change under the wide line limit. Defaults to PR_MAX_CODE_FILES, which leaves the wide tier off; never below it. User config file only. */
export const PR_WIDE_MAX_CODE_FILES = Math.max(positiveInt(pickUserFile('pr_wide_max_code_files'), PR_MAX_CODE_FILES), PR_MAX_CODE_FILES);

/** PR size budget, wide tier: most changed code lines for a wide PR. Defaults to PR_MAX_CODE_LINES; never above it. User config file only. */
export const PR_WIDE_MAX_CODE_LINES = Math.min(positiveInt(pickUserFile('pr_wide_max_code_lines'), PR_MAX_CODE_LINES), PR_MAX_CODE_LINES);

/** A switch setting: off, false, no or 0 turns it off; anything else, or unset, is the default (on). */
const switchOn = (raw: string): boolean => !/^(off|false|no|0)$/i.test(raw.trim());

/** PR body (pr-open.ts): the `##` sections every PR body must carry with real content, comma-separated. Default: Context, Reviewer guide, Risk and blast radius, Rollback / flag, How to verify locally. User config file only. */
const DEFAULT_PR_BODY_SECTIONS = ['Context', 'Reviewer guide', 'Risk and blast radius', 'Rollback / flag', 'How to verify locally'];
export const PR_BODY_SECTIONS = ((l: string[]) => (l.length ? l : DEFAULT_PR_BODY_SECTIONS))(pickUserFile('pr_body_sections').split(',').map((x) => x.trim()).filter(Boolean));

/** PR body: require a `Risk: low|medium|high` line in the risk section, and a real Rollback section when it says high. Default on. User config file only. */
export const PR_BODY_CHECK_RISK = switchOn(pickUserFile('pr_body_check_risk'));

/** PR body: require a fenced code block in the "How to verify" section unless it says `n/a` with a reason. Default on. User config file only. */
export const PR_BODY_CHECK_VERIFY = switchOn(pickUserFile('pr_body_check_verify'));

/** PR body: refuse attribution lines and obvious secret or PHI-like patterns (regex, best effort). Default on. User config file only. */
export const PR_BODY_CHECK_FORBIDDEN = switchOn(pickUserFile('pr_body_check_forbidden'));

/** PR body: a stacked PR, or one over `pr_diagram_min_files` code files, needs a mermaid diagram or a `Diagram: n/a, <reason>` line. Default on. User config file only. */
export const PR_BODY_CHECK_DIAGRAM = switchOn(pickUserFile('pr_body_check_diagram'));

/** PR body: the code-file count above which a diagram (or its n/a line) is required. Default 3. */
export const PR_DIAGRAM_MIN_FILES = positiveInt(pick('MAESTRO_PR_DIAGRAM_MIN_FILES', 'pr_diagram_min_files'), 3);

/** PR body: a stacked PR needs a `## Stack` section that names its base PR (or `n/a, <reason>`). Default on. User config file only. */
export const PR_BODY_CHECK_STACK = switchOn(pickUserFile('pr_body_check_stack'));

/** PR body: a PR over `pr_review_order_min_files` code files needs a `Review order:` line in the Reviewer guide that points at files. Default on. User config file only. */
export const PR_BODY_CHECK_ORDER = switchOn(pickUserFile('pr_body_check_order'));

/** PR body: the code-file count at which a review order is required (more than this many files). Default 3. */
export const PR_REVIEW_ORDER_MIN_FILES = positiveInt(pick('MAESTRO_PR_REVIEW_ORDER_MIN_FILES', 'pr_review_order_min_files'), 3);

/** Review queue cap: most open non-draft PRs awaiting human review before a finished branch is held as ready to push (dispatch is never held). Default 4. */
export const REVIEW_QUEUE_CAP = positiveInt(pick('MAESTRO_REVIEW_QUEUE_CAP', 'review_queue_cap'), 4);

/** Re-review gate (prs-snapshot.ts --ready): a PR with resolved review-bot threads is not ready until a fresh agent recorded SHIP IT for its head commit (review-verdict.ts). Default on; off, false, no or 0 turns it off. */
export const REREVIEW_GATE = switchOn(pick('MAESTRO_REREVIEW_GATE', 'rereview_gate'));
/** Stack cap: most PRs in one stack (a PR based on another open PR's branch). The PR board flags a deeper stack. Default 3. */
export const STACK_MAX_DEPTH = positiveInt(pick('MAESTRO_STACK_MAX_DEPTH', 'stack_max_depth'), 3);

/** Stack cap: most days since a stack's oldest PR was opened. The PR board flags an older stack. Default 5. */
export const STACK_MAX_AGE_DAYS = positiveInt(pick('MAESTRO_STACK_MAX_AGE_DAYS', 'stack_max_age_days'), 5);

const globList = (envName: string, key: string): string[] => pick(envName, key).split(',').map((s) => s.trim()).filter(Boolean);

/** A comma-separated pr-open gate list from the user config file only. */
const globListFile = (key: string): string[] => pickUserFile(key).split(',').map((s) => s.trim()).filter(Boolean);

/** Owner or `owner/name` globs as `owner/name` globs: a bare owner means `owner/*`, and an entry whose owner holds a `*` is dropped, so none can match every repo. */
const repoGlobs = (globs: string[]): string[] => globs.filter((g) => !g.split('/')[0]!.includes('*')).map((g) => (g.includes('/') ? g : `${g}/*`));

/** Repos that use the integration/release-candidate twin-PR flow (git.md "Twin PRs"), comma-separated. Empty means the rule is off. */
export const TWIN_FLOW_REPOS = pick('MAESTRO_TWIN_FLOW_REPOS', 'twin_flow_repos').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Repo name to GitHub owner, for ledger rows that name a PR as `repo#N` or `gh:pr:repo#N`: `widget=acme, gadget=acme`.
 * merge-sweep reads it so such a row can be checked and closed; an entry that is not `repo=owner` is dropped.
 */
export const REPO_OWNERS: Record<string, string> = Object.fromEntries(
  pick('MAESTRO_REPO_OWNERS', 'repo_owners').split(',').map((e) => /^\s*([\w.-]+)\s*[=:]\s*([\w.-]+)\s*$/.exec(e)).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1] as string, m[2] as string]),
);

/** Owners (orgs or users, comma-separated) whose draft PRs the pr-watch event type requests Copilot review on. Empty means nowhere. */
export const COPILOT_ORGS = globList('MAESTRO_COPILOT_ORGS', 'copilot_orgs');

/** `journal.ts next`: ticket or tracker labels that freeze an item. A frozen item is read-only and never offered as work, whatever its score. Comma-separated, matched without case; default none (an org overlay sets its own). */
export const NEXT_FROZEN_LABELS = globList('MAESTRO_NEXT_FROZEN_LABELS', 'next_frozen_labels');

/** `journal.ts next`: labels meaning the item waits on the user, so it is held back until the label is gone. Comma-separated; default needs-you; `none` clears it. */
export const NEXT_BLOCKED_LABELS: string[] = (() => {
  const raw = pick('MAESTRO_NEXT_BLOCKED_LABELS', 'next_blocked_labels', 'needs-you').trim();
  return raw.toLowerCase() === 'none' ? [] : raw.split(',').map((x) => x.trim()).filter(Boolean);
})();

/** Path globs pr-size.ts treats as tests / config / docs / mechanical. Empty means its built-in defaults. */
export const PR_TEST_GLOBS = globList('MAESTRO_PR_TEST_GLOBS', 'pr_test_globs');
export const PR_CONFIG_GLOBS = globList('MAESTRO_PR_CONFIG_GLOBS', 'pr_config_globs');
export const PR_DOCS_GLOBS = globList('MAESTRO_PR_DOCS_GLOBS', 'pr_docs_globs');
export const PR_MECHANICAL_GLOBS = globList('MAESTRO_PR_MECHANICAL_GLOBS', 'pr_mechanical_globs');

/** Smells gate (pr-open.ts, pr-smells.ts): GitHub `owner/name` globs of repos where a PR needs a recorded smells run, comma-separated. Default none, so the gate is off until a repo is named. User config file only. */
export const PR_SMELLS_REPOS = globListFile('pr_smells_repos');

/** Leak gate (pr-leaks.ts, pr-open.ts): GitHub `owner/name` globs of repos, besides this skill's own, where pr-open.ts refuses a PR that adds an org term, a personal path or a configured name. Default none. User config file only. */
export const LEAK_GATE_REPOS = globListFile('leak_gate_repos');

/**
 * Leak gate: org, person and customer names the diff must not contain, comma-separated, matched case-insensitively.
 * From the user config file or the overlay's config.md, never the environment, and never printed: the settings
 * listing shows `(set, hidden)` instead of the value, because the list is itself the sensitive part. CI reads LEAK_TERMS from a secret.
 */
export const LEAK_TERMS = (user.leak_terms ?? overlay.leak_terms ?? '').trim();
picked.set('leak_terms', { key: 'leak_terms', envName: '', value: LEAK_TERMS ? '(set, hidden)' : '', source: user.leak_terms !== undefined ? userPath : overlay.leak_terms !== undefined ? overlayPath : 'default' });

/** Review-note gate (review-note.ts, git-guard.ts, pr-open.ts): GitHub `owner/name` globs of repos where a push needs a vault Reviews note for the head commit, comma-separated. Default none, so the gate is off until a repo is named. User config file only. */
export const REVIEW_NOTE_REPOS = globListFile('review_note_repos');

/** Reviewer checklist: a file of what the org's reviewers reliably ask for (an overlay ships one). When it exists, the review-note gate also needs the note's "Reviewer checklist" section filled in. A relative path is read from the overlay's folder (else the user config's); `~/` expands. Empty when unset or when the file is missing. */
export const REVIEWER_CHECKLIST_PATH = ((v: string): string => {
  if (!v) return '';
  const p = v.startsWith('~/') ? join(homedir(), v.slice(2)) : resolve(dirname(overlayPath || userPath), v);
  return existsSync(p) ? p : '';
})(pick('MAESTRO_REVIEWER_CHECKLIST', 'reviewer_checklist').trim());

/**
 * One PR per ticket: the tracker-key pattern the rule uses. Read from the user config file only (an environment variable must not be able to
 * point it at a pattern that never matches), else the generic default, plus the local key prefixes (MAESTRO-N). Case-sensitive, so `utf-8` is not a key.
 */
export const ONE_PR_KEY_PATTERN = ((raw: string) => {
  const base = (() => { try { new RegExp(raw); return raw; } catch { return DEFAULT_TRACKER_KEY_PATTERN; } })();
  return LOCAL_KEY_PREFIXES.length ? `${base}|\\b(?:${LOCAL_KEY_PREFIXES.join('|')})-\\d+\\b` : base;
})(pickUserFile('tracker_key_pattern').trim() || DEFAULT_TRACKER_KEY_PATTERN);

/** One PR per ticket (pr-open.ts, pr-ticket-key.ts): refuse a second independent open PR that carries the same tracker key. Default on. User config file only. */
export const ONE_PR_PER_TICKET = switchOn(pickUserFile('one_pr_per_ticket'));

/** One PR per ticket: head-branch globs exempt from the rule, comma-separated. Default `release/*`. User config file only. */
export const ONE_PR_EXEMPT_HEADS = ((l: string[]) => (l.length ? l : ['release/*']))(globListFile('one_pr_exempt_heads'));

/** Size-gate waiver (pr-open.ts): GitHub owners, or `owner/name` globs, whose repos skip the PR size budget, comma-separated. A bare `owner` means `owner/*`; an owner containing `*` is ignored, so no entry can waive every repo. Default none, so every repo keeps the gate until it is named here. User config file only; there is no flag. */
export const WAIVE_SIZE_GATE_OWNERS = repoGlobs(globListFile('waive_size_gate_owners'));

/** Self-review repos: GitHub owners, or `owner/name` globs, whose PRs only you review, comma-separated. A bare `owner` means `owner/*`; an owner containing `*` is ignored, so no entry can claim every repo. Their PRs do not count toward the review queue cap and are listed apart from the rest on the PR board. Default none, so every PR is counted and listed together. */
/** Review pool: GitHub owners (or `owner/name` globs) whose PRs other people review, comma-separated. Every repo outside the pool is treated as self-review, so a personal or stray repo never counts against the review cap. Default none (no pool: only self_review_repos are left out). */
export const REVIEW_POOL_OWNERS = repoGlobs(globList('MAESTRO_REVIEW_POOL_OWNERS', 'review_pool_owners'));
/** The self-review list every caller reads: self_review_repos, plus the review pool as `!`-prefixed entries (see lib/self-review.ts). */
export const SELF_REVIEW_REPOS = [...repoGlobs(globList('MAESTRO_SELF_REVIEW_REPOS', 'self_review_repos')), ...REVIEW_POOL_OWNERS.map((g) => `!${g}`)];

/**
 * Hands-off repos (`hands_off_repos`, comma-separated `owner/name` globs or bare repo names): another person's PRs there are listed on the Others' PRs tab marked hands off
 * and the teammate helper does not draft reviews for them, unless the user is a requested reviewer. `hands_off_owner` is the login whose own PRs there stay in scope. Default none.
 */
export const HANDS_OFF_REPOS = globList('MAESTRO_HANDS_OFF_REPOS', 'hands_off_repos').map((g) => (g.includes('/') ? g : `*/${g}`));
export const HANDS_OFF_OWNER = pick('MAESTRO_HANDS_OFF_OWNER', 'hands_off_owner').trim();

/** Former teammates: GitHub logins, comma-separated, whose PRs never appear on the Others' PRs tab and are never picked for a review wait (pr-watch REVIEW-WAIT). Logins are stored lower case. Default none. */
export const FORMER_TEAMMATES = globList('MAESTRO_FORMER_TEAMMATES', 'former_teammates').map((l) => l.toLowerCase());

/** Others' PRs tab: a PR opened less than this many hours ago is never stale or dropped. Default 72. */
export const OTHERS_PRS_OPEN_HOURS = positiveInt(pick('MAESTRO_OTHERS_PRS_OPEN_HOURS', 'others_prs_open_hours'), 72);
/**
 * A PR opened longer ago stays in the active sub-tabs only with activity (a push, review, comment, re-request, or a Slack post or reply carrying the link) in this many hours; otherwise it is Stale. Default 48.
 * The older `others_prs_max_age_days` still works when this one is not set (days times 24).
 */
const LEGACY_MAX_AGE_DAYS = positiveInt(pick('MAESTRO_OTHERS_PRS_MAX_AGE_DAYS', 'others_prs_max_age_days'), 0);
export const OTHERS_PRS_ACTIVE_HOURS = positiveInt(pick('MAESTRO_OTHERS_PRS_ACTIVE_HOURS', 'others_prs_active_hours'), LEGACY_MAX_AGE_DAYS > 0 ? LEGACY_MAX_AGE_DAYS * 24 : 48);
/** Working days (Monday to Friday in `watch_tz`) without a push, comment, review or re-request after which a teammate PR leaves the Others' PRs list (Stale included). Never below the stale gate. Default 2. */
export const OTHERS_PRS_DROP_DAYS = positiveInt(pick('MAESTRO_OTHERS_PRS_DROP_DAYS', 'others_prs_drop_days'), 2);
/** Your display names in Slack, comma-separated: a reply by you in a thread is never read as a teammate claiming the PR (Others' PRs list). Default none. */
export const SLACK_SELF_NAMES = globList('MAESTRO_SLACK_SELF_NAMES', 'slack_self_names');

/** Teammate PR helper: minutes a ready PR by someone else may wait with no review before pr-watch reports `REVIEW-WAIT` for it (the orchestrator then drafts review comments for your approval; see playbooks/teammate-review.md). Unset or 0 turns it off, the default. */
export const TEAMMATE_REVIEW_MINUTES = ((raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw) : 0))(pick('MAESTRO_TEAMMATE_REVIEW_MINUTES', 'teammate_review_minutes'));

/**
 * Repost nudge (event-types/repost-nudge.ts). Every key is parsed by lib/repost-nudge-config.ts: a bad value falls back to its default and
 * says so once on stderr. Each is also an environment variable, MAESTRO_ plus the key in capitals (MAESTRO_REPOST_NUDGE_DAYS).
 */
const nudge = <T>(key: string, parse: (raw: string) => Parsed<T>): T => {
  const raw = pick(`MAESTRO_${key.toUpperCase()}`, key);
  const parsed = parse(raw);
  logProblem(key, raw, parsed);
  return parsed.value;
};
/** Master switch. Off: the watch is not registered at session start and a registered one never fires. Default on. */
export const REPOST_NUDGE_ENABLED = nudge('repost_nudge_enabled', (r) => parseSwitch(r, true));
/** Which triggers start a nudge: `approval`, `teammate-review`, comma-separated. Default both. */
export const REPOST_NUDGE_TRIGGERS = nudge('repost_nudge_triggers', parseTriggers);
/** Minutes after the latest approval on one of your open PRs before a nudge is due. `0` turns the nudge off. Default 60. */
export const REPOST_NUDGE_MINUTES = nudge('repost_nudge_minutes', (r) => parseInt10(r, 60, 0));
/** How many of your PRs a nudge names, 1 to 5. Default 3. */
export const REPOST_NUDGE_COUNT = nudge('repost_nudge_count', (r) => parseInt10(r, 3, 1, 5));
/** Repos (`owner`, `owner/name`, `owner/*`) whose approvals start the clock and whose PRs a nudge names. Empty (default): the review pool, as review_queue_cap counts it. */
export const REPOST_NUDGE_REPOS = nudge('repost_nudge_repos', parseRepos);
/** Working days, `mon-fri` by default; names, ranges and `daily` (parseDays). */
export const REPOST_NUDGE_DAYS = nudge('repost_nudge_days', (r) => parseDays(r));
/** Minimum minutes between two nudges. Default 60. */
export const REPOST_NUDGE_GAP_MINUTES = nudge('repost_nudge_gap_minutes', (r) => parseInt10(r, 60, 0));
/** Seconds between checks (one GitHub search each); at least 120, the network floor. Default 300. */
export const REPOST_NUDGE_CHECK_SECONDS = nudge('repost_nudge_check_seconds', (r) => parseInt10(r, 300, 120));
/** Hold a due nudge that has no eligible PR (for up to a day) instead of dropping it. Default off. */
export const REPOST_NUDGE_HOLD_EMPTY = nudge('repost_nudge_hold_empty', (r) => parseSwitch(r, false));
/** No nudge within this many minutes of you asking for reviews yourself (a Slack line by you with a PR link, or a review re-request of a person by you); it is held, not dropped. Default 60. */
export const REPOST_NUDGE_ASKED_MINUTES = nudge('repost_nudge_asked_minutes', (r) => parseInt10(r, 60, 0));
/** The name your lines carry in the Slack notes (`**Sam**`), case-insensitive. Default your `gh_login`; with neither set, Slack asks are not read. */
export const REPOST_NUDGE_AUTHOR = pick('MAESTRO_REPOST_NUDGE_AUTHOR', 'repost_nudge_author').trim() || GH_LOGIN;
/** IANA time zone of the working hours. Default America/New_York. */
export const REPOST_NUDGE_TZ = nudge('repost_nudge_tz', (r) => parseZone(r, 'America/New_York', (n) => validZone(n) !== undefined));
const nudgeWindow = ((): { start: string; end: string } => {
  const start = nudge('repost_nudge_start', (r) => parseClock(r, '08:30'));
  const end = nudge('repost_nudge_end', (r) => parseClock(r, '18:00'));
  const w = checkWindow(start, end, { start: '08:30', end: '18:00' });
  logProblem('repost_nudge_window', `${start}-${end}`, w);
  return w.value;
})();
/** Working hours, `HH:MM` (24 hour) in repost_nudge_tz, on repost_nudge_days. A nudge due outside them is held until the start. Defaults 08:30 and 18:00; the end must be after the start. */
export const REPOST_NUDGE_START = nudgeWindow.start;
export const REPOST_NUDGE_END = nudgeWindow.end;

/** PR body: refuse private references (wiki-links, obsidian:// links, the words ledger, vault, orchestrator) and any `pr_body_private_patterns`, in the title and body. Default on. User config file only. */
export const PR_BODY_CHECK_PRIVATE = switchOn(pickUserFile('pr_body_check_private'));

/** PR body: words that mark a private workspace and are refused outside code, comma-separated. Default ledger, vault, orchestrator; `none` turns the word list off (for a repo where they are ordinary vocabulary) while wiki-links and obsidian:// links stay refused. User config file only. */
export const PR_BODY_PRIVATE_WORDS = ((l: string[]) => (l.length === 1 && /^none$/i.test(l[0]) ? [] : l.length ? l : ['ledger', 'vault', 'orchestrator']))(globListFile('pr_body_private_words'));

/** PR body: extra regexes for install-specific private ids, comma-separated, so a pattern cannot contain a comma. Invalid ones are dropped. Added to the built-in list. User config file only. */
export const PR_BODY_PRIVATE_PATTERNS = globListFile('pr_body_private_patterns').filter((r) => { try { new RegExp(r, 'i'); return true; } catch { return false; } });

/** PR body: flag third-person references to the author (`pr_body_voice_names`) and the words assistant, agent, AI-generated, so a body reads in the author's own voice. Best effort. Default on. User config file only. */
export const PR_BODY_CHECK_VOICE = switchOn(pickUserFile('pr_body_check_voice'));

/** PR body: refuse counts the PR page already shows and a push makes stale (commits, files changed, lines, +120 -40) outside code. Best effort. Default on. User config file only. */
export const PR_BODY_CHECK_COUNTS = switchOn(pickUserFile('pr_body_check_counts'));

/** PR body: the author's names or logins, comma-separated, that must not appear in the third person ("Samwise decided"). Default none. User config file only. */
export const PR_BODY_VOICE_NAMES = globListFile('pr_body_voice_names');

/** Your git author emails (comma-separated), the authorship check branch-sweep.ts uses. Empty means the repo's own user.email. */
export const GIT_EMAILS = globList('MAESTRO_GIT_EMAILS', 'git_emails');

/** Branch names or globs (`*` within a path segment, `**` across them) branch-sweep.ts never lists, besides each repo's merge targets and default branch. */
const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'staging', 'develop', 'release/*', 'staging/*', 'hotfix/*'];
export const PROTECTED_BRANCHES = globList('MAESTRO_PROTECTED_BRANCHES', 'protected_branches').length
  ? globList('MAESTRO_PROTECTED_BRANCHES', 'protected_branches') : DEFAULT_PROTECTED_BRANCHES;

/** Per-repo merge targets for branch-sweep.ts, `repo=develop|staging, other=develop`. A repo not listed gets the default (develop, plus staging in twin-flow repos). */
export const SWEEP_MERGE_TARGETS = Object.fromEntries(globList('MAESTRO_SWEEP_MERGE_TARGETS', 'sweep_merge_targets')
  .map((e) => e.split('=')).filter(([r, t]) => r && t).map(([r, t]) => [r.trim(), t.split('|').map((b) => b.trim()).filter(Boolean)]));

/** The most priorities today's list may hold (`journal.ts priorities set` and the Podium both refuse more). Default 5; a value that is not a positive whole number falls back to it. */
export const PRIORITIES_MAX = positiveInt(pick('MAESTRO_PRIORITIES_MAX', 'priorities_max'), DEFAULT_PRIORITIES_MAX);

/** Minutes a window's lease on a ledger item lasts after the window's last row (any row it writes renews it). Default 60. */
export const LEASE_TTL_MINUTES = positiveInt(pick('MAESTRO_LEASE_TTL_MINUTES', 'lease_ttl_minutes'), 60);

/** Minutes a worktree must be untouched before branch-sweep.ts offers it for removal. Default 60. */
export const SWEEP_IDLE_MINUTES = positiveInt(pick('MAESTRO_SWEEP_IDLE_MINUTES', 'sweep_idle_minutes'), 60);

/**
 * Minutes a dispatched agent may show no progress (no commit, no edited file in its worktree) before the `stall` event type reports it.
 * Default 90: one full test run under load takes 40 to 60 minutes and two can run back to back, so the report/scratch writes and a live process in the worktree count as progress too, and 90 is the margin on top of them.
 */
export const STALL_MINUTES = positiveInt(pick('MAESTRO_STALL_MINUTES', 'stall_minutes'), 90);

/** Seconds the worktree sweep may run; once over, it stops at the next repo boundary and reports the repos it skipped. Default 300. */
export const SWEEP_BUDGET_SECONDS = positiveInt(pick('MAESTRO_SWEEP_BUDGET_SECONDS', 'sweep_budget_seconds'), 300);

/** How many days of merged PRs branch-sweep.ts reads as evidence. An older merge reads as not merged. Default 180. */
export const SWEEP_PR_DAYS = positiveInt(pick('MAESTRO_SWEEP_PR_DAYS', 'sweep_pr_days'), 180);

/** Directories whose symlinks mark a worktree as a live skill, added to the defaults (~/.claude/skills and <container>/.claude/skills). */
export const SWEEP_PROTECT_SYMLINK_DIRS = globList('MAESTRO_SWEEP_PROTECT_SYMLINK_DIRS', 'sweep_protect_symlink_dirs');

/** Ignored paths a worktree may hold and still be removed (any path segment matching). Default node_modules, .venv, dist, __pycache__. Any other ignored file keeps the worktree. */
export const SWEEP_DISPOSABLE_IGNORED = globList('MAESTRO_SWEEP_DISPOSABLE_IGNORED', 'sweep_disposable_ignored').length
  ? globList('MAESTRO_SWEEP_DISPOSABLE_IGNORED', 'sweep_disposable_ignored') : ['node_modules', '.venv', 'dist', '__pycache__'];

/**
 * The env store: the directory that holds environment files outside every worktree, as `<root>/<repo>/<project>/` (plus `<repo>/shared/`).
 * A worktree holds symlinks into it, so the sweep may remove such a worktree without losing the files. Default `~/dev-env/.env-store`. A leading `~/` is expanded.
 */
export const ENV_STORE_ROOT = ((v: string) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))(pick('MAESTRO_ENV_STORE_ROOT', 'env_store_root', '~/dev-env/.env-store').trim());

/** A shared scripts shelf (`<dir>/README.md` index, `<dir>/scratch/`, `<dir>/helpers/`). Unset means the feature is off. A leading `~/` is expanded. */
export const SCRIPTS_SHELF_DIR = ((v: string) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))(pick('MAESTRO_SCRIPTS_DIR', 'scripts_dir').trim());

/**
 * Folders the Podium may show script source from (comma-separated; a leading `~/` is expanded). Unset means the scripts shelf (`scripts_dir`) when
 * that is set, else a `scripts` folder in the `dev-env` container under the home directory. The Scripts tab reads nothing outside these roots.
 */
export const SCRIPT_ROOTS: string[] = ((raw: string) => {
  const list = raw.split(',').map((v) => v.trim()).filter(Boolean).map((v) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v));
  return list.length ? list : [SCRIPTS_SHELF_DIR || join(homedir(), 'dev-env', 'scripts')];
})(pick('MAESTRO_SCRIPT_ROOTS', 'script_roots'));

/** Where `journal.ts decide --scope working-rule` writes a memory file and its `MEMORY.md` index line. Unset means working rules are refused (a project decision needs no memory directory). A leading `~/` is expanded. */
export const MEMORY_DIR = ((v: string) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))(pick('MAESTRO_MEMORY_DIR', 'memory_dir').trim());

/** The container root the roll's worktree sweep is allowed to scan. Unset means the sweep refuses. A leading `~/` is expanded. */
/** Repo paths the agent manages itself (comma-separated, a leading ~/ expanded). The protected-branch stop does not apply there: agents may commit straight to the default branch. Empty means none. */
export const AGENT_OWNED_REPOS = globList('MAESTRO_AGENT_OWNED_REPOS', 'agent_owned_repos').map((v) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v));

export const CONTAINER_ROOT = ((v: string) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))(pick('MAESTRO_CONTAINER_ROOT', 'container_root').trim());

/** The status page directory as configured (`status_dir`); empty when unset. Set means `journal.ts status --footer` may link the page. */
export const STATUS_DIR_SETTING = expandHome(pick('MAESTRO_STATUS_DIR', 'status_dir').trim());

/** Where The-Podium.md, priorities.md, ticket-map.json and stream-overrides.json live. Default `<vault_root>/Projects/<project>/Status`; empty when neither is set. */
export const statusDirFor = (project: string): string => STATUS_DIR_SETTING || (VAULT_ROOT ? join(VAULT_ROOT, 'Projects', project, 'Status') : '');

/** The Obsidian vault name used in links. Default: the folder name of vault_root. */
/** Who a row written from the Podium page says wrote it (`by`), e.g. the owner's first name; `user` until set. */
export const PODIUM_AUTHOR = pick('MAESTRO_PODIUM_AUTHOR', 'podium_author').trim().slice(0, 40) || 'user';
export const OBSIDIAN_VAULT = pick('MAESTRO_OBSIDIAN_VAULT', 'obsidian_vault').trim() || (VAULT_ROOT ? basename(VAULT_ROOT) : '');

/** A full URI for the status page (`obsidian://...` or a URL); wins over the one derived from status_dir. */
export const STATUS_PAGE_URI_SETTING = pick('MAESTRO_STATUS_PAGE_URI', 'status_page_uri').trim();

/** Stream names in the order the status page lists them; streams found in the ledger or the repo map are added after. `other` is always last. */
export const STATUS_STREAMS = globList('MAESTRO_STATUS_STREAMS', 'status_streams');

/** `repo=Stream, other-repo=Stream`: which stream a PR in that repo (short name) belongs to on the status page. */
export const STATUS_REPO_STREAMS: Record<string, string> = Object.fromEntries(globList('MAESTRO_STATUS_REPO_STREAMS', 'status_repo_streams')
  .map((e) => e.split('=').map((x) => x.trim())).filter(([r, s]) => r && s) as [string, string][]);

/** Browse URL prefix for tracker keys (`https://tracker.example.com/browse/`). Empty: keys render as plain text. */
export const TRACKER_URL_BASE = pick('MAESTRO_TRACKER_URL_BASE', 'tracker_url_base').trim();

/** Vault-relative note path of a ticket, `{id}` and `{prefix}` (the id without its trailing number) substituted. */
export const TICKET_NOTE_PATH = pick('MAESTRO_TICKET_NOTE_PATH', 'ticket_note_path').trim() || 'Projects/{prefix}/Tickets/{id}';

/** The bare owner of a config entry (`owner` or `owner/name`); empty for a wildcard owner, which can never be an allowlist or a search scope. */
const ownerOf = (entry: string): string => { const o = entry.replace(/^!/, '').split('/')[0]!.trim(); return o.includes('*') ? '' : o; };

/** A `review_queue_orgs` entry's owner. Anything that is not a plain GitHub login (letters, digits, hyphens; an optional `/name` suffix is ignored) throws: a space-joined pair, a `!` negation or a `*` wildcard must never be read as a different, wider or empty filter. */
const queueOwner = (entry: string): string => {
  const owner = entry.split('/')[0]!;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || /\s/.test(entry)) throw new Error(`review_queue_orgs: invalid entry "${entry}" (expected comma-separated GitHub owner logins: letters, digits, hyphens)`);
  return owner;
};
const QUEUE_ORGS_LISTED = globList('MAESTRO_REVIEW_QUEUE_ORGS', 'review_queue_orgs').map(queueOwner);

/** Owners whose PRs the review queue cap counts (`review_queue_orgs`, comma-separated GitHub owner logins; a malformed entry throws). Default: `gh_org`, else none (no owner filter, the old behaviour). */
export const REVIEW_QUEUE_ORGS = QUEUE_ORGS_LISTED.length ? QUEUE_ORGS_LISTED : GH_ORG ? [GH_ORG] : [];

/** True when `review_queue_orgs` itself is set (not just inherited from `gh_org`): the PR searches are then scoped to the queue owners plus the self-review and pool owners. */
const QUEUE_ORGS_SET = QUEUE_ORGS_LISTED.length > 0;

/** Owners the shared PR search covers: the queue owners plus every self-review and pool owner, so the self-review list keeps working and no other owner is searched. */
const SEARCH_OWNERS = [...new Set([GH_ORG, ...REVIEW_QUEUE_ORGS, ...SELF_REVIEW_REPOS.map(ownerOf)].filter(Boolean))];

/** The PR search string every PR script shares. With `review_queue_orgs` set it names each owner (`user:` matches users and orgs; several qualifiers are OR), else the single `gh_org`, else every owner. */
export const PR_SEARCH = `is:pr is:open author:@me${QUEUE_ORGS_SET ? ` ${SEARCH_OWNERS.map((o) => `user:${o}`).join(' ')}` : GH_ORG ? ` org:${GH_ORG}` : ''}`;

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  console.log(`user_file:    ${userPath || '(disabled)'}${userPath && existsSync(userPath) ? '' : ' (not found)'}`);
  console.log(`overlay:      ${OVERLAY || '(none)'}`);
  console.log(`overlay_file: ${overlayPath || '(none found)'}`);
  for (const [k, v] of Object.entries({ GH_ORG, PR_SEARCH, GH_LOGIN, CONTAINER_PROJECT, CLAUDE_PROJECTS_DIR, AUTOCOMPACT_FLOOR, CLAUDE_SETTINGS_PATH, ROLL_WARN_PCT, ROLL_AT_PCT, NOTES_CHECK_SINCE, LEASE_TTL_MINUTES, COST_TARGETS: Object.entries(COST_TARGETS).map(([k, v]) => `${k}=${v}`).join(', '), MODEL_PRICES: MODEL_PRICES ? Object.entries(MODEL_PRICES).map(([f, p]) => `${f}(${PRICE_FIELDS.map((k) => `${k}=${p[k]}`).join(' ')})`).join('; ') : '', LEDGER_ROOT, VAULT_ROOT, PRIORITIES_MAX, LOOP_PATTERNS: LOOP_PATTERNS.join(', '), RESUME_GH: RESUME_GH ? 'on' : 'off', LEDGER_GIT_AUTOCOMMIT: LEDGER_GIT_AUTOCOMMIT ? 'on' : 'off', UPDATE_CHECK: UPDATE_CHECK ? 'on' : 'off', LOOP_SUPERVISOR_REQUIRED: LOOP_SUPERVISOR_REQUIRED ? 'required' : 'optional', AUTO_PULL: AUTO_PULL ? 'on' : 'off', AUTO_PULL_SET: AUTO_PULL_SET ? 'yes' : 'no', PR_MAX_CODE_FILES, PR_MAX_CODE_LINES, PR_WIDE_MAX_CODE_FILES, PR_WIDE_MAX_CODE_LINES, PR_BODY_SECTIONS: PR_BODY_SECTIONS.join(', '), PR_BODY_CHECK_RISK: PR_BODY_CHECK_RISK ? 'on' : 'off', PR_BODY_CHECK_VERIFY: PR_BODY_CHECK_VERIFY ? 'on' : 'off', PR_BODY_CHECK_FORBIDDEN: PR_BODY_CHECK_FORBIDDEN ? 'on' : 'off', PR_BODY_CHECK_DIAGRAM: PR_BODY_CHECK_DIAGRAM ? 'on' : 'off', PR_DIAGRAM_MIN_FILES, PR_BODY_CHECK_STACK: PR_BODY_CHECK_STACK ? 'on' : 'off', PR_BODY_CHECK_ORDER: PR_BODY_CHECK_ORDER ? 'on' : 'off', PR_REVIEW_ORDER_MIN_FILES, PR_SMELLS_REPOS: PR_SMELLS_REPOS.join(', '), REVIEW_NOTE_REPOS: REVIEW_NOTE_REPOS.join(', '), REVIEWER_CHECKLIST_PATH, ONE_PR_PER_TICKET: ONE_PR_PER_TICKET ? 'on' : 'off', ONE_PR_EXEMPT_HEADS: ONE_PR_EXEMPT_HEADS.join(', '), WAIVE_SIZE_GATE_OWNERS: WAIVE_SIZE_GATE_OWNERS.join(', '), SELF_REVIEW_REPOS: SELF_REVIEW_REPOS.join(', '), FORMER_TEAMMATES: FORMER_TEAMMATES.join(', '), PR_BODY_CHECK_PRIVATE: PR_BODY_CHECK_PRIVATE ? 'on' : 'off', PR_BODY_PRIVATE_WORDS: PR_BODY_PRIVATE_WORDS.join(', '), PR_BODY_PRIVATE_PATTERNS: PR_BODY_PRIVATE_PATTERNS.join(', '), PR_BODY_CHECK_VOICE: PR_BODY_CHECK_VOICE ? 'on' : 'off', PR_BODY_CHECK_COUNTS: PR_BODY_CHECK_COUNTS ? 'on' : 'off', PR_BODY_VOICE_NAMES: PR_BODY_VOICE_NAMES.join(', '), REVIEW_QUEUE_CAP, REVIEW_QUEUE_ORGS: REVIEW_QUEUE_ORGS.join(', '), REREVIEW_GATE: REREVIEW_GATE ? 'on' : 'off', STACK_MAX_DEPTH, STACK_MAX_AGE_DAYS, PR_TEST_GLOBS: PR_TEST_GLOBS.join(', '), PR_CONFIG_GLOBS: PR_CONFIG_GLOBS.join(', '), PR_DOCS_GLOBS: PR_DOCS_GLOBS.join(', '), PR_MECHANICAL_GLOBS: PR_MECHANICAL_GLOBS.join(', '), TWIN_FLOW_REPOS: TWIN_FLOW_REPOS.join(', '), REPO_OWNERS: Object.entries(REPO_OWNERS).map(([r, o]) => `${r}=${o}`).join(', '), COPILOT_ORGS: COPILOT_ORGS.join(', '), GIT_EMAILS: GIT_EMAILS.join(', '), PROTECTED_BRANCHES: PROTECTED_BRANCHES.join(', '), SWEEP_MERGE_TARGETS: Object.entries(SWEEP_MERGE_TARGETS).map(([r, t]) => `${r}=${t.join('|')}`).join(', '), SWEEP_IDLE_MINUTES, STALL_MINUTES, SWEEP_BUDGET_SECONDS, TRACKER_KEY_PATTERN, NEXT_FROZEN_LABELS: NEXT_FROZEN_LABELS.join(', '), NEXT_BLOCKED_LABELS: NEXT_BLOCKED_LABELS.join(', '), SWEEP_PROTECT_SYMLINK_DIRS: SWEEP_PROTECT_SYMLINK_DIRS.join(', '), SWEEP_DISPOSABLE_IGNORED: SWEEP_DISPOSABLE_IGNORED.join(', '), ENV_STORE_ROOT, APPROVALS_REVIEW_DAY, WATCH_MIN_INTERVAL, WATCH_MAX_INTERVAL, WATCH_NETWORK_FLOOR, WATCH_LOCAL_FLOOR, WATCH_TYPE_INTERVALS: Object.entries(WATCH_TYPE_INTERVALS).map(([t, n]) => `${t}=${n}`).join(', '), WATCH_QUIET_HOURS, WATCH_QUIET_HOURS_MODE, WATCH_QUIET_WEEKENDS: WATCH_QUIET_WEEKENDS ? 'on' : 'off', WATCH_TZ, EVENT_DIR, NOTIFY_COMMAND: NOTIFY_COMMAND.length ? '(set)' : '', INBOX_COMMAND: INBOX_COMMAND.length ? '(set)' : '', WAKE_LAUNCH_COMMAND: WAKE_LAUNCH_COMMAND.length ? '(set)' : '', SCRIPTS_DIR: SCRIPTS_SHELF_DIR, SCRIPT_ROOTS: SCRIPT_ROOTS.join(', '), STATUS_DIR: STATUS_DIR_SETTING, OBSIDIAN_VAULT, STATUS_PAGE_URI: STATUS_PAGE_URI_SETTING, STATUS_STREAMS: STATUS_STREAMS.join(', '), STATUS_REPO_STREAMS: Object.entries(STATUS_REPO_STREAMS).map(([r, s]) => `${r}=${s}`).join(', '), TRACKER_URL_BASE, TICKET_NOTE_PATH, AGENT_OWNED_REPOS: AGENT_OWNED_REPOS.join(', '), CONTAINER_ROOT })) {
    console.log(`${k.padEnd(22)} ${v || '(unset)'}`);
  }
}
