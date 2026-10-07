#!/usr/bin/env node
/**
 * COMMITMENTS SWEEP: the roll-time check that a thing the user bound the future with made it onto the board.
 *
 *   node scripts/commitments-sweep.ts [--transcript <file.jsonl>] [--projects-dir <dir>] [--vault <root>] [--project <name>] [--json]
 *
 * Reads only the human's own typed messages from a session transcript (the newest one in projects_dir, found the way
 * `journal.ts status --footer` finds its Session line, or the file given with --transcript), and pulls out the sentences that
 * read like a commitment ("we decided", "before prod", "make sure", "from now on", ...). Each is compared, by shared keywords,
 * with the open ledger items and standing pickups (read-only) and reported as MATCHED, CHECK or UNMATCHED. A model or the user judges the
 * unmatched ones; playbooks/commitments-sweep.md says what to do with each.
 *
 * It prints no typed text at all: each candidate is its turn number, its cue class, its verdict and the id of the item that carries it, so
 * a password or any other typed text cannot reach the output; the reader looks the turn up in the transcript. It never writes the
 * ledger or the standing file and never sends anything.
 * Exit codes: 0 when there are no candidates or every one is MATCHED with high confidence (the matched open item holds at least 60 percent
 * of the sentence's content words); 1 when any is UNMATCHED (no open item comes close); 3 when none is UNMATCHED but some need a CHECK (an
 * open item shares words but covers too little, so someone must judge that it means the same); 2 on a usage or read error.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_PROJECTS_DIR, CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { newestSessionFile } from './token-metrics.ts';
import { openStore } from './lib/journal/store.ts';
import { fold, isOpen } from './lib/ledger-core.ts';
import { itemText } from './lib/journal/format.ts';
import { STANDING_FILE, liveRows, readEvents } from './lib/standing.ts';
import { KEYWORD_NOTE, exitCodeOf, extractCandidates, humanTurns, judge, publicView } from './lib/commitments.ts';
import type { Known, Verdict } from './lib/commitments.ts';

const VALUE_FLAGS = new Set(['--transcript', '--projects-dir', '--vault', '--project']);
const USAGE = 'Usage: commitments-sweep.ts [--transcript <file.jsonl>] [--projects-dir <dir>] [--vault <root>] [--project <name>] [--json]';

interface Options { transcript?: string; projectsDir: string; vault: string; project: string; json: boolean }

/** The options from argv, or the reason they are unusable. */
export function parseOptions(argv: string[]): Options | string {
    const values = new Map<string, string>();
    let json = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--json') json = true;
        else if (VALUE_FLAGS.has(a)) {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
            values.set(a, v);
            i += 1;
        } else return `unknown argument ${a}`;
    }
    const vault = values.get('--vault') ?? (LEDGER_ROOT || VAULT_ROOT);
    const project = values.get('--project') ?? CONFIGURED_PROJECT;
    if (!vault) return 'ledger root is not set; set LEDGER_ROOT (or VAULT_ROOT) or pass --vault <path>';
    if (!project) return 'pass --project <name>, or set `project` in the local config';
    return { transcript: values.get('--transcript'), projectsDir: values.get('--projects-dir') ?? CLAUDE_PROJECTS_DIR, vault, project, json };
}

/** A rule row (`journal.ts rule`): a decision that is already made, is not pending and points at the file that keeps it. It stays true, so it carries a commitment without being open. */
const isRule = (i: { kind?: string; pending?: boolean; refs?: unknown; closedBy?: unknown }): boolean => i.kind === 'decision' && i.pending !== true && !i.closedBy && Array.isArray(i.refs) && i.refs.length > 0;

/** What the board still carries: every OPEN ledger item's text and every rule row's (a finished item carries nothing forward), and every live standing pickup's trigger and action. Read-only. */
export function knownItems(vault: string, project: string): Known[] {
    const store = openStore({ vault, project, dryRun: true, warn: () => {} });
    const items = fold(store.readLedger(), store.loadRegistry()).items
        .filter((i) => i.id && (isOpen(i) || isRule(i)))
        .map((i): Known => ({ kind: 'ledger', id: i.id as string, text: [itemText(i), i.gate].filter(Boolean).join(' ') }));
    const standing = liveRows(readEvents(join(store.dir, STANDING_FILE))).map((r): Known => ({ kind: 'standing', id: r.id, text: `${r.id} ${r.trigger} ${r.action}` }));
    return [...items, ...standing];
}

export function render(transcript: string, verdicts: Verdict[], turns: number): string {
    const count = (v: Verdict['verdict']): number => verdicts.filter((x) => x.verdict === v).length;
    const rows = verdicts.map(publicView).map((v) => `${String(v.turn).padStart(5)}  ${String(v.line).padStart(6)}  ${v.verdict.padEnd(9)}  ${v.cue.padEnd(22)}  ${v.match ? `${v.match.kind} ${v.match.id} (${v.match.coveragePercent}% of the sentence)` : '-'}`);
    return [
        `transcript: ${transcript}`,
        `${turns} human turns read, ${verdicts.length} candidate commitments, ${count('UNMATCHED')} UNMATCHED, ${count('CHECK')} CHECK`,
        '',
        ...(verdicts.length ? ['turn    line  verdict    cue                     carried by', ...rows, '', 'No typed text is printed. `line` is the line of the transcript file (jq -c \'.\' | sed -n <line>p, or any pager); `--json` adds the message uuid and time when the transcript has them. `turn` counts typed messages from 1.'] : ['(no commitment cues in the human turns)']),
        '',
        `Note: ${KEYWORD_NOTE}`,
    ].join('\n');
}

function main(): void {
    const opts = parseOptions(process.argv.slice(2));
    if (typeof opts === 'string') { console.error(`commitments-sweep: ${opts}\n${USAGE}`); process.exit(2); }
    const transcript = opts.transcript ?? newestSessionFile(opts.projectsDir);
    if (!transcript || !existsSync(transcript)) {
        console.error(`commitments-sweep: ${opts.transcript ? `no such transcript ${opts.transcript}` : `no sessions in ${opts.projectsDir}; set projects_dir or pass --transcript`}`);
        process.exit(2);
    }
    const ledgerFile = join(opts.vault, 'Projects', opts.project, 'Journal', 'ledger.jsonl');
    if (!existsSync(ledgerFile)) { console.error(`commitments-sweep: no ledger at ${ledgerFile}; check --vault and --project (an empty ledger would report everything UNMATCHED)`); process.exit(2); }
    let turns;
    try { turns = humanTurns(readFileSync(transcript, 'utf8')); } catch (e) { console.error(`commitments-sweep: cannot read ${transcript}: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
    const verdicts = judge(extractCandidates(turns), knownItems(opts.vault, opts.project));
    console.log(opts.json ? JSON.stringify({ transcript, humanTurns: turns.length, note: KEYWORD_NOTE, candidates: verdicts.map(publicView) }, null, 2) : render(transcript, verdicts, turns.length));
    process.exitCode = exitCodeOf(verdicts);
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
