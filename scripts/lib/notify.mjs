/**
 * Optional notifier for the event loop. `notify_command` (local-config) is an argv array; the one-line
 * summary is appended as its last argument. There is no default recipient: with no command set this does nothing.
 * The command runs without a shell, so event text can never be interpreted as shell syntax.
 */
import { spawnSync } from 'node:child_process';

export const MAX_SUMMARY = 150;
export const MAX_PER_TICK = 3;

/** One line, at most 150 characters. */
export const oneLine = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_SUMMARY ? flat : `${flat.slice(0, MAX_SUMMARY - 3)}...`;
};

/**
 * Sends one notification per actionable event (at most MAX_PER_TICK, then one "+N more" line).
 * `run(cmd, args)` defaults to spawnSync; tests pass a stub. Returns the summaries sent. A failing
 * command is reported on stderr and never throws, so a broken notifier cannot stop the loop.
 */
export function notify(events, command, run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 30000 })) {
  if (!command?.length || !events.length) return [];
  const lines = events.slice(0, MAX_PER_TICK).map((e) => oneLine(`${e.watch}: ${e.summary}`));
  if (events.length > MAX_PER_TICK) lines.push(oneLine(`+${events.length - MAX_PER_TICK} more event(s); see the digest`));
  const sent = [];
  for (const line of lines) {
    const r = run(command[0], [...command.slice(1), line]);
    if (r?.error || r?.status) console.error(`notify command failed: ${r.error?.message ?? `exit ${r.status}`}`);
    else sent.push(line);
  }
  return sent;
}
