#!/usr/bin/env node
/**
 * event-inject.ts: the SessionStart and UserPromptSubmit hook that puts unseen actionable events in front of the orchestrator.
 *
 *   event-inject.ts
 *
 * Input is the hook's JSON on stdin (`session_id`, `hook_event_name`). Output is plain stdout, which Claude Code adds to the turn:
 * at most MAX_HEADLINES headlines for events this window may take, then one `Loop:` health line when it says something worth
 * seeing. Those events are marked `seen` (not `handled`); the orchestrator acts on them and acks.
 *
 * Local files only, no network. FAIL-OPEN: any error prints nothing and exits 0, so a broken inbox never blocks a prompt.
 * A headline is built from the event's allowlisted `fields` and `kind` alone, never from a summary, so no title, comment body,
 * login or org name can reach the prompt through this hook.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claimFor } from '../event-loop.ts';
import { EVENT_DIR } from '../local-config.ts';
import type { InboxEntry } from '../lib/event-inbox.ts';
import { liveLoopHealth } from '../lib/loop-health-live.ts';
import type { LoopHealth } from '../lib/loop-health.ts';
import { resolveWindowId, windowEnv } from '../lib/window-id.ts';

export const MAX_HEADLINES = 8;

export interface InjectDeps {
  claim: (window: string | undefined, limit: number) => InboxEntry[];
  health: () => LoopHealth;
}

/** `thread arya-scraper#542 (human)`, or `3 new texts from Jack (read with claude-inbox --new)` for the inbox type. Fields only. */
export function headline(e: InboxEntry): string {
  const { repo, number, who, count } = e.fields;
  if (e.kind === 'message') return `${count ?? 'new'} new text${count === 1 ? '' : 's'} from Jack (read with claude-inbox --new)`;
  const target = repo && number ? ` ${repo}#${number}` : repo ? ` ${repo}` : '';
  return `${e.kind}${target}${who ? ` (${who})` : ''} [${e.id}]`;
}

/** A healthy or unused loop is not worth a line on every prompt; a SessionStart always shows a non-empty one. */
const worthShowing = (h: LoopHealth, start: boolean): boolean => h.line !== '' && (start || !['ok', 'quiet', 'absent'].includes(h.state));

/** The text for one hook call; '' when there is nothing to say. Never throws. */
export function inject(event: string | undefined, window: string | undefined, deps: InjectDeps): string {
  try {
    const events = deps.claim(window, MAX_HEADLINES);
    const health = deps.health();
    const lines = events.map((e) => `- ${headline(e)}`);
    const showLoop = worthShowing(health, event === 'SessionStart') || (events.length > 0 && health.line !== '');
    if (!lines.length && !showLoop) return '';
    return [lines.length ? `Unseen events (${lines.length}; act, then \`event-loop.ts events ack <id>\`):` : '', ...lines, showLoop ? health.line : ''].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as { session_id?: unknown; hook_event_name?: unknown };
    const window = resolveWindowId({ session: typeof input.session_id === 'string' ? input.session_id : undefined, ...windowEnv() });
    const text = inject(typeof input.hook_event_name === 'string' ? input.hook_event_name : undefined, window, { claim: (w, n) => claimFor(EVENT_DIR, w, () => {}, n), health: () => liveLoopHealth() });
    if (text) console.log(text);
  } catch { /* fail open: print nothing */ }
  process.exit(0);
}
