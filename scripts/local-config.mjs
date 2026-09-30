/**
 * LOCAL CONFIG: the one place the-maestro's scripts read install-specific values.
 *
 * Everything else in scripts/ is generic. Set the matching environment variable to change a
 * value. The prose side of this overlay names the settings in reference/local-config.md.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** GitHub org the PR board is scoped to. Unset or empty means no org filter. */
export const GH_ORG = process.env.MAESTRO_GH_ORG ?? '';

/** Your GitHub login. Unset means "whoever `gh` is authenticated as". */
export const GH_LOGIN = process.env.MAESTRO_GH_LOGIN || '';

/** The container directory's project name, used for ledger paths (Projects/<name>/Journal/). */
export const CONTAINER_PROJECT = process.env.MAESTRO_PROJECT || 'dev-env';

/**
 * Claude Code's transcript directory for the container, read by token-metrics.mjs. Claude Code
 * names it after the working directory with every path separator turned into a dash.
 */
export const CLAUDE_PROJECTS_DIR =
  process.env.MAESTRO_PROJECTS_DIR || join(homedir(), '.claude', 'projects', process.cwd().replace(/[\\/]/g, '-'));

/** The PR search string every PR script shares. */
export const PR_SEARCH = `is:pr is:open author:@me${GH_ORG ? ` org:${GH_ORG}` : ''}`;
