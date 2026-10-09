/**
 * The id of the orchestrator window a write came from, so two windows on one ledger can be told apart.
 *
 * Resolved in this order, first non-empty wins:
 *   1. an explicit `--window`;
 *   2. the session id (`--session`, or the `session_id` a hook or status line gives);
 *   3. `MAESTRO_WINDOW`, an override a hook or a shell can set;
 *   4. `CLAUDE_CODE_SESSION_ID`, which Claude Code exports into every Bash tool call and every hook of a session, so each separate
 *      `journal.ts` process of one window sees the same value with no setup (this is what makes the id stable);
 *   5. `c<CLAUDE_PID>`, the Claude Code process itself: also exported into the tool environment, stable for the life of the window
 *      and different for two windows, for a Claude Code that does not export the session id;
 *   6. `p<parent pid>`, the shell that launched the command. Each Bash tool call is a new shell, so this one is NOT stable across calls;
 *      it is the last resort, and `windowNotice` tells the user when it is the one in use.
 *
 * An id is a short token (letters, digits, `_`, `-`, at most 12 characters): a session id is a uuid, and its first characters are enough to
 * tell windows apart while keeping a ledger row small. Anything else is stripped, so a value from a flag or the environment cannot
 * put free text into a row.
 */
export const WINDOW_ID_MAX = 12;

export interface WindowSources { window?: string; session?: string; env?: string; claudeSession?: string; claudePid?: string; ppid?: number }
export type WindowSource = 'flag' | 'session' | 'env' | 'claude-session' | 'claude-pid' | 'ppid';
export interface ResolvedWindow { id: string; source: WindowSource; stable: boolean }

/** A token made only of the characters an id may hold, or '' when nothing is left. */
export function cleanWindowId(raw: string | undefined): string {
    return (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, WINDOW_ID_MAX);
}

/** The environment-derived sources (rungs 3 to 5 above) from a process environment, so every caller reads the same variables. */
export function windowEnv(env: NodeJS.ProcessEnv = process.env): Pick<WindowSources, 'env' | 'claudeSession' | 'claudePid'> {
    return { env: env.MAESTRO_WINDOW, claudeSession: env.CLAUDE_CODE_SESSION_ID, claudePid: env.CLAUDE_PID };
}

/** The window id for one run and where it came from; `stable` is false only for the per-shell pid fallback. */
export function resolveWindow({ window, session, env, claudeSession, claudePid, ppid = process.ppid }: WindowSources): ResolvedWindow {
    const pid = /^\d{1,10}$/.test(claudePid ?? '') ? `c${claudePid}` : '';
    const rungs: [string, WindowSource][] = [[cleanWindowId(window), 'flag'], [cleanWindowId(session), 'session'], [cleanWindowId(env), 'env'], [cleanWindowId(claudeSession), 'claude-session'], [pid, 'claude-pid']];
    const hit = rungs.find(([id]) => id);
    return hit ? { id: hit[0], source: hit[1], stable: true } : { id: `p${ppid}`, source: 'ppid', stable: false };
}

/** The window id for one run; never empty. See the module comment for the order. */
export function resolveWindowId(sources: WindowSources): string {
    return resolveWindow(sources).id;
}

/** The loud line for an unstable id, or '' when the id is stable. */
export function windowNotice(w: ResolvedWindow): string {
    return w.stable ? '' : `Window id ${w.id} is UNSTABLE: nothing identifies this Claude Code window (no CLAUDE_CODE_SESSION_ID, CLAUDE_PID or MAESTRO_WINDOW), so each Bash call gets a new id. Export MAESTRO_WINDOW=<anything stable> before leases or routing are used.`;
}
