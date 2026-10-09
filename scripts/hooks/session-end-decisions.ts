#!/usr/bin/env node
/**
 * session-end-decisions.ts: the SessionEnd hook. PreCompact does not fire on /clear or when a session ends, so decisions typed
 * after the last compaction would never be scanned; this runs only the decision scan (no handoff, no snapshot) and raises
 * them as ask rows. SessionEnd hooks get 1.5 s unless the settings give a longer timeout (up to 60 s); the snippet asks for 30.
 *
 *   session-end-decisions.ts [--project <name>] [--vault <ledger-root>]
 *
 * Input is the hook's JSON on stdin (`transcript_path`, `session_id`, `reason`). Always exits 0.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decisionsOnly, realDeps } from './precompact.ts';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    decisionsOnly(input, realDeps(process.argv.slice(2)));
  } catch (e) {
    console.error(`session-end-decisions hook: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}
