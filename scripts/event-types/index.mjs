/**
 * The event types index. A type is `scripts/event-types/<type>.mjs` exporting
 * { check(target, ctx) -> state, diff(prev, next) -> events[], done?(state, watch) -> boolean },
 * plus a playbook at `playbooks/event-types/<type>.md`. Registering one is that pair of files and one line here.
 */
export const TYPES = {};
