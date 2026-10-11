#!/usr/bin/env node
/**
 * QUEUE REPORT: open rows that look already done. Read-only; it closes and writes nothing.
 *
 *   queue-report.ts [--json] [--vault <path>] [--project <name>]
 *
 * Lists, for the open ledger rows (in flight and queued):
 *   - rows naming a pull request that GitHub says is MERGED (looked up with `gh pr view`; MAESTRO_GH_BIN points at another gh),
 *     each with the `journal.ts done <id>` command to close it if you agree: the report never runs it;
 *   - queued rows that already have a built branch (a tracker key they name appears in a branch name of their repo), as the footer's Queue line counts them.
 * A PR whose owner or state cannot be resolved is counted as unknown, never as merged. Root and project resolve as flow-report.ts does.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, CONTAINER_ROOT, GH_ORG, LEDGER_ROOT, TRACKER_KEY_PATTERN, VAULT_ROOT } from './local-config.ts';
import { fold, isInFlight, isQueued } from './lib/ledger-core.ts';
import { mergedRows, type PrRef } from './lib/pr-refs.ts';
import { gitBranches, queueHygiene } from './lib/queue-hygiene.ts';
import { openStore } from './lib/journal/store.ts';
import { parseArgs } from './lib/journal/args.ts';

const ghBin = (): string => process.env.MAESTRO_GH_BIN || 'gh';

/** `owner/name` for a repo directory under the container root, from its origin URL, else (not when `strict`) `gh_org/<repo>`; undefined when neither is known. */
function ownerOf(repo: string, strict = false): string | undefined {
    if (CONTAINER_ROOT) {
        const r = spawnSync('git', ['-C', join(CONTAINER_ROOT, repo), 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
        const m = r.status === 0 ? /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout) : null;
        if (m) return m[1];
    }
    return GH_ORG && !strict ? `${GH_ORG}/${repo}` : undefined;
}

function stateOf(ref: PrRef): string | undefined {
    const r = spawnSync(ghBin(), ['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'state', '-q', '.state'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function main(argv: string[]): number {
    const { arg, has } = parseArgs(['queue-report', ...argv]);
    const vault = arg('vault', LEDGER_ROOT || VAULT_ROOT);
    const project = arg('project') || CONFIGURED_PROJECT;
    if (!vault || !project) { console.error('queue-report: pass --vault <ledger root> and --project <name> (or set LEDGER_ROOT and the configured project).'); return 2; }
    const store = openStore({ vault, project, dryRun: true });
    const items = fold(store.readLedger(), store.loadRegistry()).items;
    const open = items.filter((i) => isInFlight(i) || isQueued(i));
    const merged = mergedRows(open, ownerOf, stateOf);
    const lists = new Map<string, string[]>();
    const branchesOf = (repo: string | undefined): string[] => {
        const dir = repo && CONTAINER_ROOT ? join(CONTAINER_ROOT, repo) : fileURLToPath(new URL('..', import.meta.url));
        if (!lists.has(dir)) lists.set(dir, gitBranches(dir));
        return lists.get(dir) as string[];
    };
    const built = queueHygiene(items.filter(isQueued), new Date().toISOString().slice(0, 10), TRACKER_KEY_PATTERN, branchesOf).built;
    if (has('json')) { console.log(JSON.stringify({ merged, built }, null, 2)); return 0; }
    console.log(`Open rows naming a merged PR (${merged.length}); nothing was closed:`);
    for (const m of merged) console.log(`  ${m.id}  ${m.text}\n      ${m.prs.map((p) => `${p.ref.repo}#${p.ref.number} ${p.state}`).join(', ')}${m.allMerged ? '' : '  (other PRs on this row are not merged)'}\n      close if you agree: journal.ts done ${m.id}`);
    console.log(`\nQueued rows with a built branch (${built.length}):`);
    for (const b of built) console.log(`  ${b.id}  ${b.branch}`);
    return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
