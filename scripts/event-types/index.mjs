/**
 * The event types index. A type is `scripts/event-types/<type>.mjs` exporting
 * { check(target, ctx) -> state, diff(prev, next) -> events[], done?(state, watch) -> boolean, retired?(watch, ctx),
 * validate?(target, { now, ttlMs }) (throws to refuse a watch at `add`), defaultTtlMs?(target, now) },
 * and optionally `interval` (default seconds between checks), `network` (false for a check that never leaves the machine),
 * `backoff` (false to skip the idle back-off), `notifies` ('default' or 'never'; unset means opt-in with --notify),
 * plus a playbook at `playbooks/event-types/<type>.md`. Registering a built-in one is that pair of files and one line here.
 * diff(null, next) is the first check: report only what is already worth waking for. An event is { summary, actionable? }.
 *
 * An org overlay adds types without touching this repo: `<overlay dir>/event-types/<type>.mjs` with its playbook
 * `<overlay dir>/event-types/<type>.md` beside it, same interface. The overlay dir is the directory holding the
 * overlay's `config.md` (see local-config.mjs). `loadTypes` rejects duplicate names and malformed modules loudly.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { overlayPath } from '../local-config.mjs';
import * as ghRun from './gh-run.mjs';
import * as inbox from './inbox.mjs';
import * as prChecks from './pr-checks.mjs';
import * as prMerged from './pr-merged.mjs';
import * as prReview from './pr-review.mjs';
import * as prWatch from './pr-watch.mjs';
import * as reminder from './reminder.mjs';

export const BUILTIN_TYPES = { 'pr-checks': prChecks, 'pr-merged': prMerged, 'pr-review': prReview, 'pr-watch': prWatch, 'gh-run': ghRun, inbox, reminder };

const OPTIONAL_HOOKS = ['done', 'retired', 'validate', 'defaultTtlMs'];

/** Throws unless `mod` has check and diff functions (and done/retired, when present, are functions). */
function assertType(name, mod, file) {
  for (const fn of ['check', 'diff']) {
    if (typeof mod?.[fn] !== 'function') throw new Error(`overlay event type ${name} (${file}): export ${fn}() as a function`);
  }
  for (const fn of OPTIONAL_HOOKS) {
    if (mod[fn] !== undefined && typeof mod[fn] !== 'function') throw new Error(`overlay event type ${name} (${file}): ${fn} must be a function when exported`);
  }
}

/**
 * The built-in types plus those in `<overlayDir>/event-types/*.mjs`. No overlayDir, or no such folder, returns
 * the built-ins unchanged. Throws if an overlay type reuses a name, lacks check/diff, or has no playbook.
 */
export async function loadTypes({ overlayDir = '', builtin = BUILTIN_TYPES } = {}) {
  const types = { ...builtin };
  const typesDir = overlayDir && join(overlayDir, 'event-types');
  if (!typesDir || !existsSync(typesDir)) return types;
  for (const entry of readdirSync(typesDir).filter((f) => f.endsWith('.mjs')).sort()) {
    const name = entry.slice(0, -'.mjs'.length);
    const file = join(typesDir, entry);
    if (name in types) throw new Error(`overlay event type ${name} (${file}) duplicates an existing type`);
    if (!existsSync(join(typesDir, `${name}.md`))) throw new Error(`overlay event type ${name} (${file}) has no playbook ${name}.md beside it`);
    const mod = await import(pathToFileURL(file).href);
    assertType(name, mod, file);
    types[name] = mod;
  }
  return types;
}

/**
 * Every type this install knows: built-ins plus the configured overlay's. Called where types are needed, never at
 * import time, so a broken overlay stops the loop but not tests, `add`, or cleanup of built-in watches.
 */
export const loadConfiguredTypes = () => loadTypes({ overlayDir: overlayPath ? dirname(overlayPath) : '' });
