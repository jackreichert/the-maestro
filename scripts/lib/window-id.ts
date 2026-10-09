/**
 * The id of the orchestrator window a write came from, so two windows on one ledger can be told apart.
 *
 * Resolved in this order, first non-empty wins: an explicit `--window`, the session id (`--session`, or the `session_id` a status
 * line gives on stdin), the `MAESTRO_WINDOW` environment variable (a SessionStart hook can export it), then a pid-based fallback
 * `p<parent pid>`. The fallback is the process that launched the command, which is stable for as long as that shell lives and
 * differs between two windows; it is a last resort, not a promise that one window keeps one id across shells.
 *
 * An id is a short token (letters, digits, `_`, `-`, at most 12 characters): a session id is a uuid, and its first characters are enough to
 * tell windows apart while keeping a ledger row small. Anything else is stripped, so a value from a flag or the environment cannot
 * put free text into a row.
 */
export const WINDOW_ID_MAX = 12;

export interface WindowSources { window?: string; session?: string; env?: string; ppid?: number }

/** A token made only of the characters an id may hold, or '' when nothing is left. */
export function cleanWindowId(raw: string | undefined): string {
    return (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, WINDOW_ID_MAX);
}

/** The window id for one run; never empty. See the module comment for the order. */
export function resolveWindowId({ window, session, env, ppid = process.ppid }: WindowSources): string {
    return cleanWindowId(window) || cleanWindowId(session) || cleanWindowId(env) || `p${ppid}`;
}
