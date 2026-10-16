import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerItem } from '../ledger-core.ts';

/**
 * Ledger drift: agents the harness has running that no in-flight row accounts for. The ledger only knows what was written to it,
 * so an agent dispatched without `journal.ts start` (or without the dispatch hook installed) is invisible and the footer says "0 in
 * flight" while six agents run. The harness keeps one transcript per subagent under `<projects>/<session>/subagents/` with a
 * `.meta.json` beside it (description, agent type, spawn depth); a transcript written to in the last couple of minutes is a running
 * agent. Only agents the orchestrator spawned (spawnDepth 1) count: the ones those agents spawn are their own business.
 *
 * Limits, stated: "running" is inferred from the last write, so an agent that finished less than `RUNNING_WINDOW_MS` ago still counts,
 * and one waiting on a tool for longer does not. A row matches an agent by its id in the description, or by the description's words
 * (one contains the other, ignoring case and punctuation); a row closed in the last ten minutes still accounts for its agent.
 */

/** A subagent transcript written to within this long ago is running. */
export const RUNNING_WINDOW_MS = 120_000;
/** A row closed this recently still accounts for an agent that has not stopped writing yet. */
/** Shortest text that can account for another by containment. */
const MIN_MATCH = 8;
const CLOSED_GRACE_MS = 10 * 60_000;
/** Only sessions whose directory changed within this long are searched, so a year of old sessions is never listed. */
const SESSION_RECENT_MS = 24 * 3_600_000;

export interface RunningAgent { description: string; agentType: string; session: string }

const words = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** True when `inner` appears in `outer` as whole words ("tracked thing" is not in "untracked thing"). */
const contains = (outer: string, inner: string): boolean => ` ${outer} `.includes(` ${inner} `);

/** The subagents of `session` (or of every recently active session) whose transcript was written within `withinMs` of `now`. */
export function runningAgents(projectsDir: string, now: number, opts: { session?: string; withinMs?: number } = {}): RunningAgent[] {
  const withinMs = opts.withinMs ?? RUNNING_WINDOW_MS;
  if (!existsSync(projectsDir)) return [];
  const sessions = opts.session && /^[\w-]+$/.test(opts.session) ? [opts.session] : readdirSync(projectsDir).filter((n) => !n.endsWith('.jsonl') && n !== 'memory');
  const out: RunningAgent[] = [];
  for (const session of sessions) {
    const dir = join(projectsDir, session, 'subagents');
    let files: string[] = [];
    try {
      if (!opts.session && now - statSync(join(projectsDir, session)).mtimeMs > SESSION_RECENT_MS) continue;
      files = readdirSync(dir);
    } catch { continue; /* no subagents folder: that session has nothing countable */ }
    for (const f of files) {
      // Per file: one meta file still being written must not hide the agents after it.
      try {
        if (!f.endsWith('.jsonl') || now - statSync(join(dir, f)).mtimeMs > withinMs) continue;
        const meta = JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')) as { description?: unknown; agentType?: unknown; spawnDepth?: unknown };
        if (meta.spawnDepth !== undefined && meta.spawnDepth !== 1) continue;
        out.push({ description: typeof meta.description === 'string' ? meta.description : '', agentType: typeof meta.agentType === 'string' ? meta.agentType : '', session });
      } catch { /* an unreadable meta file: skip this agent only */ }
    }
  }
  return out;
}

/** The running agents no row accounts for: no in-flight row (or row closed in the last ten minutes) names the agent's description or id. */
export function untrackedAgents(agents: readonly RunningAgent[], items: readonly LedgerItem[], now: number): RunningAgent[] {
  const tracking = items.filter((i) => i.kind === 'wip' && (!i.closedBy || now - Date.parse(String(i.closedBy.ts)) < CLOSED_GRACE_MS) && (i.closedBy || !i.queued));
  return agents.filter((a) => {
    const d = words(a.description) || '(no description)';
    return !tracking.some((i) => {
      const t = words(String(i.text ?? ''));
      // The length rule applies both ways: a one-word description ("fix") is not accounted for by any row that happens to contain it.
      return (i.id && d.split(' ').includes(i.id.toLowerCase())) || (d.length >= MIN_MATCH && contains(t, d)) || (t.length >= MIN_MATCH && contains(d, t));
    });
  });
}

/** How many running agents no row accounts for. The footer passes its session; the continuity tick, which has none, searches every recent session. */
export function untrackedCount(projectsDir: string, items: readonly LedgerItem[], now: number, session?: string): number {
  return untrackedAgents(runningAgents(projectsDir, now, { session }), items, now).length;
}

/** Which of the maestro Agent hooks are missing from a Claude settings file: `agent-dispatch.ts` (PreToolUse) and `agent-return.ts` (SubagentStop). A file that cannot be read reports both. Never returns any of the file's content. */
export function missingAgentHooks(settingsPath: string): string[] {
  let hooks: Record<string, { hooks?: { command?: unknown }[] }[]> = {};
  try { hooks = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: typeof hooks }).hooks ?? {}; } catch { /* unreadable: both missing */ }
  const has = (event: string, file: string): boolean => (hooks[event] ?? []).some((e) => (e.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(file)));
  return [...(has('PreToolUse', 'agent-dispatch.ts') ? [] : ['agent-dispatch.ts']), ...(has('SubagentStop', 'agent-return.ts') ? [] : ['agent-return.ts'])];
}

/** The footer text for the drift: empty when nothing is untracked, else `ledger drift: 3 untracked agents`, naming a missing hook as the likely cause. */
export function driftLine(untracked: number, missingHooks: readonly string[]): string {
  if (!untracked) return '';
  return `ledger drift: ${untracked} untracked agent${untracked === 1 ? '' : 's'}${missingHooks.length ? ` (${missingHooks.join(' and ')} not in settings.json: print-settings-snippet.ts has the entries)` : ' (start a row for each: journal.ts start "<text>")'}`;
}
