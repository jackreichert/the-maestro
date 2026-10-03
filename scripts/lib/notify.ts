/**
 * Optional notifier for the event loop. `notify_command` (local-config) is an argv array; the one-line
 * summary is appended as its last argument. There is no default recipient: with no command set this does nothing.
 * Notification is opt-in per watch: only a watch added with `--notify` (a reminder: unless `--no-notify`) notifies,
 * and the inbox type never does. watchNotifies() is the single check; the loop applies it on every tick.
 * The command runs without a shell, so event text can never be interpreted as shell syntax.
 */
import { spawnSync } from 'node:child_process';
import type { EventType, Watch } from './types.ts';

/** Runs the notifier. Only the outcome matters, so a runner may report just `status` or `error`, or nothing. */
export type NotifyRun = (cmd: string, args: string[]) => { status?: number | null; error?: Error } | undefined;

/**
 * Whether a watch's actionable events may be sent to `notify_command`. A type that declares `notifies = 'never'`
 * overrides the watch's own flag, so a hand-edited registry cannot make it notify.
 */
export const watchNotifies = (watch: Pick<Watch, 'notify'>, type: Pick<EventType, 'notifies'> | undefined): boolean => type?.notifies !== 'never' && watch.notify === true;

/**
 * The `notify` value `add` stores: --notify or --no-notify if given, else the type's default (`notifies = 'default'`
 * means on), else off. Throws on both flags together, or --notify for a type that never notifies.
 */
export function notifyChoice(type: Pick<EventType, 'notifies'> | undefined, { notify = false, noNotify = false }: { notify?: boolean; noNotify?: boolean } = {}): boolean {
  if (notify && noNotify) throw new Error('--notify and --no-notify cannot be used together');
  if (notify && type?.notifies === 'never') throw new Error('this watch type never notifies');
  if (type?.notifies === 'never') return false;
  if (notify || noNotify) return notify;
  return type?.notifies === 'default';
}

export const MAX_SUMMARY = 150;
export const MAX_PER_TICK = 3;

/** One line, at most `max` characters (150 for a notification). */
export const oneLine = (text: unknown, max = MAX_SUMMARY): string => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
};

/**
 * Sends one notification per actionable event (at most MAX_PER_TICK, then one "+N more" line).
 * `run(cmd, args)` defaults to spawnSync; tests pass a stub. Returns the summaries sent. A failing
 * command is reported on stderr and never throws, so a broken notifier cannot stop the loop.
 */
export function notify(
  events: { watch: string; summary: string }[],
  command: string[] | undefined,
  run: NotifyRun = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 30000 }),
): string[] {
  if (!command?.length || !events.length) return [];
  const lines = events.slice(0, MAX_PER_TICK).map((e) => oneLine(`${e.watch}: ${e.summary}`));
  if (events.length > MAX_PER_TICK) lines.push(oneLine(`+${events.length - MAX_PER_TICK} more event(s); see the digest`));
  const sent = [];
  for (const line of lines) {
    const r = run(command[0] as string, [...command.slice(1), line]);
    if (r?.error || r?.status) console.error(`notify command failed: ${r.error?.message ?? `exit ${r.status}`}`);
    else sent.push(line);
  }
  return sent;
}
