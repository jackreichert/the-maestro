import { kindsOf } from './pricing.ts';
import type { Usage } from './pricing.ts';

/** A gap longer than this (seconds) is past the 5-minute prompt-cache lifetime. */
export const EXPIRY_GAP_SEC = 300;
/** A turn must write at least this many 5m cache tokens to count as a rewrite of a whole context, not new content. */
export const EXPIRY_MIN_WRITE = 30_000;
/** Whether `t` is a cache-expiry rewrite: idle past the cache lifetime, then a large 5m write. */
export const isExpiryRewrite = <T extends Usage & { gapSec?: number }>(t: T): boolean => t.gapSec !== undefined && t.gapSec > EXPIRY_GAP_SEC && kindsOf(t).w5 >= EXPIRY_MIN_WRITE;
