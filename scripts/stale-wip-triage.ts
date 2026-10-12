#!/usr/bin/env node
/**
 * STALE WIP TRIAGE: lists every open in-flight ledger row with the evidence for closing it. Read-only; it writes nothing.
 *
 *   stale-wip-triage.ts [--json] [--today YYYY-MM-DD] [--tickets-vault <notes vault>] [--vault <ledger root>] [--project <name>]
 *
 * Each row shows its age, when anything last touched it, its ticket and that ticket's status (with --tickets-vault), how many of
 * its child rows are closed, and the PRs its text names. A row whose ticket is closed or whose children are all closed is marked
 * CLOSE (hard evidence); every other row is marked ASK. It closes nothing: see playbooks/stale-wip-triage.md for what to do with it.
 * Root and project resolve as journal.ts does: --vault, then $LEDGER_ROOT, then $VAULT_ROOT; --project or the configured project.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { fold } from './lib/ledger-core.ts';
import { openStore } from './lib/journal/store.ts';
import { printJson } from './lib/json-out.ts';
import { parseArgs } from './lib/journal/args.ts';
import { renderEvidence, staleEvidence } from './lib/stale-triage.ts';

export function main(argv: string[]): number {
    const { arg, has } = parseArgs(['triage', ...argv]);
    const vault = arg('vault', LEDGER_ROOT || VAULT_ROOT);
    const project = arg('project') || CONFIGURED_PROJECT;
    if (!vault || !project) {
        console.error('stale-wip-triage: pass --vault <ledger root> and --project <name> (or set LEDGER_ROOT and the configured project).');
        return 2;
    }
    const today = arg('today', new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) { console.error('stale-wip-triage: --today must be YYYY-MM-DD.'); return 2; }
    const store = openStore({ vault, project, dryRun: true });
    const entries = store.readLedger();
    const { items, hidden } = fold(entries, store.loadRegistry());
    const rows = staleEvidence(entries, items.filter((i) => !hidden.has(String(i.id))), today, arg('tickets-vault') || undefined);
    if (has('json')) printJson({ date: today, count: rows.length, rows });
    else renderEvidence(rows, today).forEach((l) => console.log(l));
    return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
// exitCode, not exit(): exiting right after a large write to a pipe cuts the output off at the pipe buffer.
if (isMain()) process.exitCode = main(process.argv.slice(2));
