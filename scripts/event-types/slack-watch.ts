/**
 * slack-watch: tagged Slack conversations, watched without a model. Target is the tag registry file (an absolute path to the .json
 * that `slack-pull --register` upserts). Each check is one cheap history call per conversation (limit 1, newer than the last
 * cursor); nothing newer costs nothing and says nothing. New messages are pulled into the note and the new lines alone land in a
 * file beside it, reported as one line: SLACK-NEW tag= note= new= file=. A conversation the token can no longer read reports
 * SLACK-UNSHARED once. The behaviour is the shared engine in lib/tag-watch.ts; the Slack calls live in the separate slack-sync
 * skill, which this shim loads on first use (see findSkillFile for where it looks, SLACK_SYNC_DIR overrides).
 * Default every 300 s, 72 h lifetime, notifies unless the watch is added with --no-notify.
 */
import { tagWatchType } from '../lib/tag-watch.ts';

const type = tagWatchType('slack-sync', 'scripts/slack-watch-adapter.ts', { interval: 300 });

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = type.interval;
export const renews = true;
export const network = type.network;
export const backoff = type.backoff;
export const slowInQuiet = type.slowInQuiet;
// Notification: on unless the watch is added with --no-notify.
export const notifies = type.notifies;
export const { check, diff, validate, defaultTtlMs } = type;
