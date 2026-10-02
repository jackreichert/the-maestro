/**
 * The event types index. A type is `scripts/event-types/<type>.mjs` exporting
 * { check(target, ctx) -> state, diff(prev, next) -> events[], done?(state, watch) -> boolean },
 * plus a playbook at `playbooks/event-types/<type>.md`. Registering one is that pair of files and one line here.
 * diff(null, next) is the first check: report only what is already worth waking for. An event is { summary, actionable? }.
 */
import * as ghRun from './gh-run.mjs';
import * as inbox from './inbox.mjs';
import * as prChecks from './pr-checks.mjs';
import * as prReview from './pr-review.mjs';

export const TYPES = { 'pr-checks': prChecks, 'pr-review': prReview, 'gh-run': ghRun, inbox };
