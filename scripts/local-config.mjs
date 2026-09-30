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

/** The PR search string every PR script shares. */
export const PR_SEARCH = `is:pr is:open author:@me${GH_ORG ? ` org:${GH_ORG}` : ''}`;

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  console.log(`user_file:    ${userPath || '(disabled)'}${userPath && existsSync(userPath) ? '' : ' (not found)'}`);
  console.log(`overlay:      ${OVERLAY || '(none)'}`);
  console.log(`overlay_file: ${overlayPath || '(none found)'}`);
  for (const [k, v] of Object.entries({ GH_ORG, GH_LOGIN, CONTAINER_PROJECT, CLAUDE_PROJECTS_DIR, LEDGER_ROOT, VAULT_ROOT, LOOP_PATTERNS: LOOP_PATTERNS.join(', '), RESUME_GH })) {
    console.log(`${k.padEnd(20)} ${v || '(unset)'}`);
  }
}
