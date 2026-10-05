/**
 * notion-watch: tagged Notion pages, watched without a model. Target is the tag registry file (an absolute path to the .json
 * that `notion-pull` upserts). Each check is one cheap GET per page; an unchanged page costs nothing and says nothing. A change
 * re-pulls the page, writes a diff file beside its note and reports one line: NOTION-CHANGED tag= note= diff= summary=.
 * A page that was unshared or deleted reports NOTION-UNSHARED once. The behaviour is the shared engine in lib/tag-watch.ts;
 * the Notion calls live in the separate notion-sync skill, which this shim loads on first use (see findSkillFile for where it looks).
 * Default every 900 s, 72 h lifetime, notifies unless the watch is added with --no-notify.
 */
import { tagWatchType } from '../lib/tag-watch.ts';

const type = tagWatchType('notion-sync', 'scripts/notion-watch-adapter.ts', { interval: 900 });

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = type.interval;
export const network = type.network;
export const backoff = type.backoff;
export const slowInQuiet = type.slowInQuiet;
// Notification: on unless the watch is added with --no-notify.
export const notifies = type.notifies;
export const { check, diff, validate, defaultTtlMs } = type;
