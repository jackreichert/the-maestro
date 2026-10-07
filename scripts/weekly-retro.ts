#!/usr/bin/env node
/**
 * WEEKLY RETRO: a ten-minute retro draft from the ledger. Read-only; it writes nothing.
 *
 *   weekly-retro.ts [--days 7] [--stale-days 7] [--json] [--now <ISO time>] [--vault <path>] [--project <name>]
 *
 * Prints what is stale, blocked and dropped, how much finished, and last week's experiment with its keep or drop
 * verdict (or "undecided"). Record the next experiment and the verdict as ledger notes (see lib/weekly-retro.ts).
 * Root and project resolve as journal.ts does: --vault, then $LEDGER_ROOT, then $VAULT_ROOT; --project or the configured project.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { fold } from './lib/ledger-core.ts';
import { openStore } from './lib/journal/store.ts';
import { parseArgs } from './lib/journal/args.ts';
import { renderRetro, weeklyRetro } from './lib/weekly-retro.ts';

export function main(argv: string[]): number {
    const { arg, has } = parseArgs(['retro', ...argv]);
    const vault = arg('vault', LEDGER_ROOT || VAULT_ROOT);
    const project = arg('project') || CONFIGURED_PROJECT;
    if (!vault || !project) {
        console.error('weekly-retro: pass --vault <ledger root> and --project <name> (or set LEDGER_ROOT and the configured project).');
        return 2;
    }
    const days = Number(arg('days', '7'));
    const staleDays = Number(arg('stale-days', '7'));
    const now = new Date(arg('now', new Date().toISOString()));
    if (!(days > 0) || !(staleDays > 0) || Number.isNaN(now.getTime())) {
        console.error('weekly-retro: --days and --stale-days must be positive numbers, --now an ISO time.');
        return 2;
    }
    const store = openStore({ vault, project, dryRun: true });
    const entries = store.readLedger();
    const { items, hidden } = fold(entries, store.loadRegistry());
    const retro = weeklyRetro(entries, items.filter((i) => !hidden.has(String(i.id))), now, days, staleDays);
    console.log(has('json') ? JSON.stringify(retro, null, 2) : renderRetro(retro));
    return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exit(main(process.argv.slice(2)));
