/**
 * inbox: new messages from the user, read through the `inbox_command` local-config setting. Target is ignored (use `inbox`).
 * The command prints one line per unread message and must NOT mark them read, or the orchestrator could never read them.
 * Message text is personal data: only a hash of each line is kept, and the only event text is a count.
 */
import { createHash } from 'node:crypto';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

/** Hashes of the unread lines, never the lines themselves. */
export interface InboxState { ids: string[] }

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = 60;
export const renews = true;
export const network = false;
// Notification: never sent to notify_command, whatever the watch says.
export const notifies = 'never' as const;

/** Hashes each line with its occurrence number, so two identical messages count twice. */
export function fingerprints(stdout: string): string[] {
  const seen = new Map<string, number>();
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    return createHash('sha256').update(`${n}:${line}`).digest('hex').slice(0, 16);
  });
}

export function check(_target: string, ctx: Pick<CheckContext, 'run' | 'config'>): InboxState {
  const argv = ctx.config?.inboxCommand ?? [];
  if (!argv.length) throw new Error('inbox_command is not set in local-config');
  const r = ctx.run(argv[0] as string, argv.slice(1));
  if (r.status !== 0) throw new Error(`inbox command exited ${r.status}`);
  return { ids: fingerprints(r.stdout) };
}

export function diff(prev: InboxState | null, next: InboxState): WatchEvent[] {
  const known = new Set(prev?.ids ?? []);
  const fresh = next.ids.filter((id) => !known.has(id)).length;
  return fresh ? [{ summary: `${fresh} new message(s) from user` }] : [];
}
