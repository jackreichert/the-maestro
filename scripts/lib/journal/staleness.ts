/**
 * The ledger's staleness thresholds, in one place. The footer, `status --json`, `roll` and `triage` all read these, so they cannot
 * disagree about when a row has been sitting too long (they used to: the footer said 3 days, triage said 1).
 */

/** Days an in-flight row may sit with no live lease and no touch before every surface calls it stale. `stale_wip_days` overrides it. */
export const DEFAULT_STALE_WIP_DAYS = 3;

/** Days a queued row may wait before `roll --strict` refuses: a to-do older than this is either work to start or a row to drop. */
export const STALE_QUEUED_DAYS = 7;
