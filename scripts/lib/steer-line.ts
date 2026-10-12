/**
 * The format of pr-watch's failing-check steering line, `[self-review] STEER pr <n> failing check <STATE>`. The emitter (event-types/pr-watch.ts)
 * builds it from these pieces and the triage rules match it with `STEER_FAILING_CHECK`, so the two cannot drift apart.
 */
export const STEER_PREFIX = 'STEER pr';
export const FAILING_CHECK_PHRASE = 'failing check';

/** Matches the steering line for a failing check, after the self-review tag has been stripped. */
export const STEER_FAILING_CHECK = new RegExp(`^${STEER_PREFIX} \\d+ ${FAILING_CHECK_PHRASE}\\b`);
