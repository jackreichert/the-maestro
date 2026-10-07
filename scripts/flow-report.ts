#!/usr/bin/env node
/**
 * FLOW REPORT: cycle time, throughput, WIP and open-item age, read from the ledger. Read-only; it writes nothing.
 *
 *   flow-report.ts [--days 14] [--oldest N] [--json] [--now <ISO time>] [--vault <path>] [--project <name>]
 *
 * Prints, for the last --days days (default 14): items done and per week, the median (p50) and 85th percentile
 * (p85) start-to-done time, work in flight now, and the age of every open item, oldest first (--oldest N caps the list).
 * p85 is the number to quote as a service level: "85% of items finish within p85 days".
 * Root and project resolve as journal.ts does: --vault, then $LEDGER_ROOT, then $VAULT_ROOT; --project or the
 * configured project. Definitions live in lib/flow.ts. Run it on Friday; the roll prints it too.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { fold } from './lib/ledger-core.ts';
import { flowReport, renderFlow } from './lib/flow.ts';
import { openStore } from './lib/journal/store.ts';
import { parseArgs } from './lib/journal/args.ts';

export function main(argv: string[]): number {
    const { arg, has } = parseArgs(['flow', ...argv]);
    const vault = arg('vault', LEDGER_ROOT || VAULT_ROOT);
    const project = arg('project') || CONFIGURED_PROJECT;
    if (!vault || !project) {
        console.error('flow-report: pass --vault <ledger root> and --project <name> (or set LEDGER_ROOT and the configured project).');
        return 2;
    }
    const days = Number(arg('days', '14'));
    const oldest = arg('oldest') === null ? Infinity : Number(arg('oldest'));
    const now = new Date(arg('now', new Date().toISOString()));
    if (!Number.isFinite(days) || days <= 0 || Number.isNaN(oldest) || Number.isNaN(now.getTime())) {
        console.error('flow-report: --days must be a positive number, --oldest a number, --now an ISO time.');
        return 2;
    }
    const store = openStore({ vault, project, dryRun: true });
    const report = flowReport(fold(store.readLedger(), store.loadRegistry()).items, now, days);
    console.log(has('json') ? JSON.stringify(report, null, 2) : renderFlow(report, oldest));
    return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exit(main(process.argv.slice(2)));
