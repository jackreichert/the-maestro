/**
 * Is the `continuity` watch registered and is the loop that runs it alive? PreCompact asks this before a compaction: a tick that is not
 * running leaves the live handoff to go stale, which is how a handoff once ended up 87 minutes behind the ledger.
 */
import { EVENT_DIR } from '../local-config.ts';
import { liveLoopHealth } from './loop-health-live.ts';
import type { LoopState } from './loop-health.ts';
import type { Watch } from './types.ts';
import { listWatches } from './watch-registry.ts';

const REGISTER = 'node scripts/event-loop.ts add --id continuity --type continuity --target <transcripts dir> --ttl-hours 72';

/** One actionable line when the watch is missing, expired, or its loop is not alive; null when the tick can be trusted. Pure. */
export function continuityWatchProblem(watches: Watch[], health: { state: LoopState }, now: number): string | null {
  const live = watches.some((w) => w.type === 'continuity' && Date.parse(w.expires) > now);
  if (!live) return `not registered; run \`${REGISTER}\``;
  if (['stalled', 'down', 'not-installed', 'absent'].includes(health.state)) return `registered but the event loop is not alive (${health.state}); start it with \`node scripts/event-loop.ts run\` or check the supervisor`;
  return null;
}

/** The check against this machine's registry and loop. */
export function liveContinuityWatchProblem(now: number = Date.now()): string | null {
  return continuityWatchProblem(listWatches(EVENT_DIR), liveLoopHealth(now), now);
}
