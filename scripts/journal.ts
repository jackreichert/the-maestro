#!/usr/bin/env node
/**
 * Working ledger for the multi-repo orchestrator.
 *
 * Answers "what did we do today, and what is still open" without anyone having
 * to ask. Append-only, so it survives context compaction and session restarts.
 *
 * Storage lives in $LEDGER_ROOT/Projects/{project}/Journal/ (moved out of the
 * vault on 2026-09-26 so the day-to-day ledger stays out of Obsidian search;
 * falls back to $VAULT_ROOT if LEDGER_ROOT is unset, for anyone still on the
 * old single-root layout).
 * --project is required unless the local config sets `project` (or MAESTRO_PROJECT); an explicit --project wins. There is no built-in default.
 *
 *   ledger.jsonl     append-only source of truth, one JSON object per line
 *   CURRENT.md       GENERATED view of what is open + done today
 *   YYYY-MM-DD.md    GENERATED daily archive, written by `roll`
 *   Streams/<S>.md   GENERATED one page per active stream (and a retro pointer for archived ones)
 *
 * The JSONL is the source of truth precisely so the markdown can be read and
 * edited freely without breaking anything. Regenerate with `render`.
 *
 *   journal.ts log "<text>" --model "<name>" --used "skill:x,tool:y" [--kind note]
 *   journal.ts start "<text>" --model "<name>" --used "skill:x,tool:y" [--repo x]
 *   journal.ts done <id|text> --model "<name>" --used "skill:x,tool:y"
 *   journal.ts drop <id> --model "<name>" --used "skill:x,tool:y" [--why "..."]
 *   journal.ts ask "<question>" [--kind question|decision] --model "<name>" --used "skill:x,tool:y"
 *                                             a question for the user; --kind decision is a decision still pending (it stays on the board)
 *   journal.ts ask "<what to run>" --paste <block-file>   a run-this ask: the file must exist; shown as "Paste blocks for you", apart from the questions
 *   journal.ts triage [--date D] [--since D] [--apply] [--json]   box every open item and the day's decisions and notes, flag stale/unpromoted/unticketed, print the don't-miss
 *                                             checklist. Read-only; --apply appends `resolved` rows ("recorded → <ref>") for rules and approvals whose ref is an existing file
 *   journal.ts log "<text>" --kind blocked --gate gh:pr:<repo>#N|date:YYYY-MM-DD|ticket:<id>   what a blocked item waits for; `resume` checks it (report only)
 *   journal.ts defer <id> --until YYYY-MM-DD   hide an open item from the board until that date (a later date in the future, never in the past)
 *   journal.ts prime [--no-update-check]     the box view for session start and after a compaction: 40 lines or fewer. First line: one update line when this skill's repo is behind, ahead, diverged or dirty (a git fetch, 15s cap; update_check off skips it); silent when current
 *   journal.ts rule "<text>" --ref <file> --model "<name>" --used "skill:x,tool:y"
 *                                             record a decision already made and promoted: refuses (exit 1, nothing written) unless every --ref is an existing file; never open
 *   journal.ts resolve <id> --model "<name>" --used "skill:x,tool:y" [--answer "..."]
 *   journal.ts stamp <id> --model "<name>" --used "skill:x,tool:y"
 *   journal.ts stamp-missing [--model unrecorded] [--used unrecorded] [--tokens unmeasured]
 *   journal.ts usage [--open]                counts of model and used marks across items
 *   journal.ts status [--full]               what is open + done today, with usage marks
 *   journal.ts status --footer               the reply-footer Ledger lines, one per active stream, then the Session line
 *   journal.ts standup [--date YYYY-MM-DD]   end-of-day summary for the team, no usage marks
 *   journal.ts roll [--date YYYY-MM-DD] [--strict] [--container <dir>] [--no-worktree-sweep]
 *                                             first runs triage: plain roll warns about its blockers, --strict refuses (exit 1) before changing anything
 *                                             archive finished work to a dated note, commit the ledger root if configured, and only THEN sweep: it removes
 *                                             the stale worktrees branch-sweep.ts would offer, with no approval step (a standing approval; never
 *                                             --force, never a branch), prunes worktrees whose directory is gone, and prints what it removed and
 *                                             kept with reasons. It scans only the configured container_root, and refuses (the roll goes on) when none is set or when the
 *                                             current directory (or --container) is outside it; --dry-run only reports. --fast skips the sweep and the scratch review.
 *   journal.ts scratch                       with scripts_dir set: list <scripts_dir>/scratch with a promote/keep/delete-candidate proposal (`roll` prints it too; proposes only)
 *   journal.ts verify [--json]               check every line parses, ids are unique, every reference exists; exit 1 on problems
 *   journal.ts render                        rebuild CURRENT.md and Journal/Streams/<Stream>.md from the ledger
 *   journal.ts tag <id> --stream <name>      file an existing item under a workstream
 *   journal.ts log "<text>" --kind decision --approval standing|one-off [--scope "<what it covers>"] [--ref <memory-file-or-url>] --model ... --used ...
 *                                             an approval the user granted; `resolve` takes --approval too
 *   journal.ts approvals [--since YYYY-MM-DD | --days 7] [--until YYYY-MM-DD] [--out <path>] [--force] [--json]   the approvals digest: standing (keep/narrow/revoke), one-off, untagged decisions
 *   journal.ts approve-tag <id> --approval standing|one-off [--scope ..] [--ref ..]   mark an existing row as an approval (appends a row; nothing is rewritten)
 *   journal.ts streams [list|add <name> [--alias a,b]|check]   the stream registry
 *   journal.ts models [list|add <id> [--alias a,b]|check]   the model-name registry (a `models` section of streams.json)
 *   journal.ts fact <key>=<value> --stream <name>   a structured metric; not an item, never open
 *   journal.ts carry <id> --to <stream>      re-home an item (e.g. an open follow-up) to another stream
 *   journal.ts retro <stream> [--out <path>] [--force]   draft the epic retro doc (status: draft)
 *   journal.ts archive <stream>              hide a finished stream; refuses until retro + promotions are done
 *   journal.ts unarchive <stream>            bring an archived stream back, exactly
 *   journal.ts claim <repo> --desk <stream> [--branch b] [--why "..."] [--pid n]   take an exclusive repo lock (Claims/<repo>.lock)
 *   journal.ts release <repo> --desk <stream> [--force]   drop it; only the holding desk may, unless --force
 *   journal.ts claims [--stale-hours 12] [--json]         list claims with a stale check
 *   journal.ts backfill [--dry-run] [--samples N] [--out <report.md>] [--json]   propose a stream for untagged items; writes nothing
 *   journal.ts backfill --apply --min-confidence high|medium|low   append `tag` events for those proposals (one batch, one render)
 *   journal.ts handoff --stream <name> | --all [--learn "<text>"] [--next "<text>"] [--update-context [--context-file <path>]] [--out <path>] [--since YYYY-MM-DD] [--delta] [--force] [--container <dir>] [--no-worktree-sweep]   (--delta: when today's handoff exists, write HANDOFF-<date>b-<stream>.md etc. with only what changed since its generated_at) scaffold the five-part handoff (--learn and --next fill sections 2 and 5) (Cleanup candidates lists the worktrees a sweep would keep, read-only)
 *   journal.ts log "<text>" --transitioned KEY[,KEY]   record that tracker ticket(s) were moved (a note with a `transitioned` field; the pending check reads it)
 *   journal.ts tickets --pending [--since D] [--json]   done items carrying a tracker key (tracker_key_pattern) with no recorded transition, since D (default 14 days); `prime` and `triage` flag them
 *   journal.ts resume                        the verify-on-resume checklist, running the parts a script can run
 *
 * Workstreams: pass --stream <name> to log/start/ask (or `tag` an existing item)
 * and the item is shown in its own section, e.g. "Launch", ahead of the rest.
 * If $LEDGER_ROOT/Projects/<project>/streams.json exists it is the registry: aliases and
 * case fold to the canonical name on write and on read, and an unknown name is rejected
 * with a suggestion unless --new-stream is passed. No registry, no enforcement.
 * status, standup and render hide archived streams; --include-archived shows them.
 *
 * Model names: a `models` section in the same registry ({ "claude-opus-5-5": { "aliases": ["Claude Opus 5.5", "opus"] } })
 * folds --model to the canonical id on write and on read. An unknown name warns and is written as-is.
 *
 * Integrity: `verify` checks the ledger file. With ledger_git_autocommit on and $LEDGER_ROOT a git repo, `roll` runs
 * verify and then commits the changed files under that root (explicit paths, never -A) as `chore(ledger): roll <date>`.
 *
 * Handoff and resume: `handoff` writes Journal/HANDOFF-<date>-<stream>.md (status: draft) from the ledger and never
 * overwrites without --force. `resume` runs ledger status, `gh pr list` and pgrep; the loop patterns and whether
 * gh is used come from the config file (loop_patterns, resume_gh), never from this script.
 *
 * Every new entry requires --model and --used. --tokens and --harness are optional.
 * Do not invent either. Unknown history is `unrecorded`, unmeasured tokens are
 * `unmeasured`. --allow-unmarked is only for tests and migrations.
 *
 * Kinds: wip | done | blocked | question | decision (not open, unless `ask --kind decision`) | note | resolved | dropped | rolled | stamp
 *        (rows only written by their own commands: tag | fact | carry | archive | unarchive)
 * Common flags: --vault <path> --project <name> --json --dry-run --include-archived
 * retro/archive read tickets through ledger-index.ts: --tickets-vault <path> (else $VAULT_ROOT),
 * --repo <name> picks Projects/<name>/Archive/ for the retro doc (default dev-env).
 * Root precedence: --vault, then $LEDGER_ROOT, then $VAULT_ROOT, each also settable in the
 * config file (see local-config.ts).
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, renameSync, linkSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { hostname, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LEDGER_ROOT, VAULT_ROOT, LOOP_PATTERNS, RESUME_GH, LEDGER_GIT_AUTOCOMMIT, CLAUDE_PROJECTS_DIR, SCRIPTS_SHELF_DIR, CONTAINER_ROOT, SWEEP_BUDGET_SECONDS, TRACKER_KEY_PATTERN, CONFIGURED_PROJECT, UPDATE_CHECK, AUTO_PULL, AUTO_PULL_SET, userPath } from './local-config.ts';
import { setAutoPull } from './lib/config-write.ts';
import { checkForUpdate } from './lib/self-update.ts';
import { fileURLToPath } from 'node:url';
import { scratchReport } from './lib/scratch.ts';
import { parseArgs } from './lib/journal/args.ts';
import { openStore } from './lib/journal/store.ts';
import { didYouMean, formatUsed, usageSuffix, fmt, slug, cell, clip, itemText } from './lib/journal/format.ts';
import { streamTitle, activeStreams, inStream, noStream, groups as boardGroups, footerLines, standupText as boardStandupText, render as boardRender } from './lib/journal/board.ts';
import { triageReport as triageReportIn, triageLines } from './lib/journal/triage.ts';
import { verifyLedger as verifyLedgerIn, autoCommitLedger as autoCommitLedgerIn } from './lib/journal/verify.ts';
import { primeLines as primeLinesIn, gateReport as gateReportIn, pendingTransitions as pendingTransitionsIn, defaultPendingSince } from './lib/journal/prime.ts';
import { ticketStatuses as ticketStatusesIn, retroText as retroTextIn, findRetro as findRetroIn, archiveBlockers as archiveBlockersIn, PR_WORDS, LEARNING, TICKET_ID } from './lib/journal/retro.ts';
import { claimPath as claimPathIn, validRepo as validRepoIn, readClaim as readClaimIn, claimStaleness, describeClaim, acquireClaimLock } from './lib/journal/claims.ts';
import { CONF, backfillProposals as backfillProposalsIn } from './lib/journal/backfill.ts';
import { yesterday, handoffText as handoffTextIn, handoffDeltaText, handoffSeries, handoffMarker, updateContextLink as updateContextLinkIn } from './lib/journal/handoff.ts';
import { isoWeek, isDate, approvalsWindow, collectApprovals, approvalsText, approvalMap } from './lib/journal/approvals.ts';
import { defaultContext, keptCounts, sweepWorktrees, worktreeSweepLines } from './branch-sweep.ts';
import { sessionLine } from './token-metrics.ts';
import { BOX, BOX_TITLES, RECORD_BOXES, ACTIONS, classify, isStale, daysBetween, parseGate, gateStatus } from './lib/boxes.ts';
import { activeDeferrals, isOpen, isNoStream, NON_ITEM_KINDS, mergeMark, readRegistry, canonicalOf, canonicalModel, mapModelWith, mapStreamWith, fold as foldWith } from './lib/ledger-core.ts';
import type { LedgerItem, LedgerRow, Registry } from './lib/ledger-core.ts';
import type { TryRun } from './lib/journal/prime.ts';

const DEFAULT_LEDGER_ROOT = LEDGER_ROOT || VAULT_ROOT;
const KINDS = ['wip', 'done', 'blocked', 'question', 'decision', 'note', 'resolved', 'dropped', 'rolled', 'stamp', 'tag', 'approval-tag'];

/** The values --approval accepts. Anything else is rejected at write time and flagged by `verify`. */
const APPROVALS = new Set(['standing', 'one-off']);

/** Row kinds that may carry --approval when written (`approve-tag` writes its own approval-tag row). */
const APPROVAL_WRITE_KINDS = new Set(['decision', 'resolved']);

/** Row kinds an approval can point at: the user's decision, their answer to an ask, or the ask itself. */
const APPROVABLE_KINDS = new Set<string | undefined>(['decision', 'resolved', 'question']);

const argv = process.argv.slice(2);
const cmd = argv[0];

const { arg, has, positional } = parseArgs(argv);

// `autopull on|off` writes the user config file and needs no ledger, so it runs before the ledger root is required.
if (cmd === 'autopull') {
    try {
        const value = positional[0] ?? '';
        console.log(`autopull  ${value.trim().toLowerCase()}  ${setAutoPull(userPath, value)}  ${userPath}`);
        if (process.env.MAESTRO_AUTO_PULL !== undefined) console.error('Note: MAESTRO_AUTO_PULL is set in the environment and overrides the config file.');
    } catch (e) {
        console.error(`${e instanceof Error ? e.message : String(e)} Usage: journal.ts autopull on|off`);
        process.exit(1);
    }
    process.exit(0);
}

const dryRun = has('dry-run');
const asJson = has('json');
const vault = arg('vault', DEFAULT_LEDGER_ROOT);
if (!vault) {
    console.error('Ledger root is not set. Ask where the ledger lives, then set LEDGER_ROOT (or VAULT_ROOT), or pass --vault <path>.');
    process.exit(1);
}
const projectArg = arg('project') || CONFIGURED_PROJECT;
if (!projectArg) {
    console.error('Pass --project <container-folder-name>, or set `project` in the local config (MAESTRO_PROJECT). There is no built-in default.');
    process.exit(1);
}
const project: string = projectArg;
const { dir, ledgerPath, registryPath, rollPoint, ensureDir, readLedger, append, appendMany, loadRegistry, saveRegistry, newId } = openStore({ vault, project, dryRun });
const today = (): string => new Date().toISOString().slice(0, 10);
const now = (): string => new Date().toISOString();
/** The message of a caught value; `catch` binds `unknown`. */
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Wrappers: the extracted triage, verify and prime modules read the run through these contexts.
const triageCtx = () => ({ readLedger, fold, today, resolveRefFile });
const verifyCtx = () => ({ ledgerPath, approvals: APPROVALS, approvableKinds: APPROVABLE_KINDS, autocommit: LEDGER_GIT_AUTOCOMMIT, dryRun, vault });
const primeCtx = () => ({ groups, readLedger, fold, today, project, tryRun, ticketStatuses, arg });
const triageReport = (d: string, since?: string) => triageReportIn(triageCtx(), d, since);
const verifyLedger = () => verifyLedgerIn(verifyCtx());
const autoCommitLedger = (d: string) => autoCommitLedgerIn(verifyCtx(), d);
const gateReport = () => gateReportIn(primeCtx());
const pendingTransitions = (since: string) => pendingTransitionsIn(primeCtx(), since);

// ── stream registry ─────────────────────────────────────────────────────────

/** Read-time mapping through the loaded registry. */
const mapStream = (s: string | undefined) => mapStreamWith(loadRegistry(), s);

/**
 * Write-time normalisation for --stream. `none` stays reserved and passes through. With no
 * registry nothing is enforced. An unknown name is rejected with a suggestion unless --new-stream.
 */
function normaliseStream(raw: string): string;
function normaliseStream(raw: string | null): string | null;
function normaliseStream(raw: string | null): string | null {
    if (!raw) return raw;
    if (isNoStream(raw)) return 'none';
    const reg = loadRegistry();
    if (!reg || !reg.hasStreams) return raw;
    const canon = canonicalOf(reg, raw);
    if (canon) {
        if (reg.streams[canon]?.status === 'archived') {
            console.error(`Stream "${canon}" is archived. Run \`journal.ts unarchive ${canon}\` first.`);
            process.exit(1);
        }
        if (canon !== raw) console.error(`normalised ${raw} -> ${canon}`);
        return canon;
    }
    if (has('new-stream')) {
        if (!dryRun) {
            reg.streams[raw] = { aliases: [], status: 'active' };
            reg.hasStreams = true;
            saveRegistry(reg);
        }
        console.error(`registered new stream ${raw}`);
        return raw;
    }
    const near = didYouMean(reg, raw);
    console.error(`Unknown stream "${raw}".${near ? ` Did you mean "${near}"?` : ''}`);
    console.error(`Known: ${Object.keys(reg.streams).join(', ') || '(none)'}. Pass --new-stream to register it, or \`journal.ts streams add <name>\`.`);
    process.exit(1);
}

/** Stream for a new row: `none` (reserved) and absent both mean no stream. */
function streamOrNone(raw: string | null): string | undefined {
    const s = normaliseStream(raw);
    return s === 'none' ? undefined : s || undefined;
}

const fold = (entries: LedgerRow[]) => foldWith(entries, loadRegistry());

// The board modules read the run through this: the ledger, the registry and the clock.
const boardCtx = { readLedger, fold, today, rollPoint, has, mapStream, loadRegistry, dryRun, ensureDir, dir };
const groups = (includeArchived?: boolean) => boardGroups(boardCtx, includeArchived);
const standupText = (d: string) => boardStandupText(boardCtx, d);
const render = (quiet?: boolean, includeArchived?: boolean) => boardRender(boardCtx, quiet, includeArchived);

function resolveTarget(items: LedgerItem[], needle: string | undefined): LedgerItem | null {
    if (!needle) return null;
    const exact = items.find((i) => i.id === needle);
    if (exact) return exact;
    const open = items.filter(isOpen);
    const matches = open.filter((i) => i.text?.toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
        console.error(`"${needle}" matches ${matches.length} open items:`);
        matches.forEach((m) => console.error(`  ${m.id}  ${m.text}`));
        process.exit(1);
    }
    return null;
}

function parseList(name: string): string[] | undefined {
    const raw = arg(name);
    if (!raw) return undefined;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
}

const MODEL_SENTINELS = new Set(['unrecorded', 'n/a', 'unmeasured']);

/**
 * Write-time normalisation for --model. Needs a `models` section in the registry; without one nothing
 * changes. A registered alias is written as its canonical id. An unknown name is warned about and
 * written as-is: the ledger has odd historic values, so this never rejects.
 */
function normaliseModel(raw: string | null): string | null {
    const reg = loadRegistry();
    if (!raw || MODEL_SENTINELS.has(raw) || !reg?.models || !Object.keys(reg.models).length) return raw;
    const canon = canonicalModel(reg, raw);
    if (!canon) {
        console.error(`unknown model "${raw}": not in the registry, written as-is. Register it with \`journal.ts models add <id> --alias "${raw}"\`.`);
        return raw;
    }
    if (canon !== raw) console.error(`normalised model ${raw} -> ${canon}`);
    return canon;
}

/** The usage marks every written row carries, from --model, --used and the optional --tokens, --harness and --agent. */
interface Usage { model?: string; used?: string[]; tokens?: string; harness?: string; agent?: string }

function usageFromArgs(): Usage {
    const model = normaliseModel(arg('model'));
    const used = parseList('used');
    if (!has('allow-unmarked') && (!model || !used)) {
        console.error('Every ledger entry needs --model "<name>" and --used "skill:x,tool:y".');
        console.error('Do not guess. Unknown is --model unrecorded --used unrecorded. Tests may pass --allow-unmarked.');
        process.exit(1);
    }
    const usage: Usage = {};
    if (model) usage.model = model;
    if (used) usage.used = used;
    const tokens = arg('tokens');
    const harness = arg('harness');
    const agent = arg('agent');
    if (tokens) usage.tokens = tokens;
    if (harness) usage.harness = harness;
    if (agent) usage.agent = agent;
    return usage;
}

// ── commands ────────────────────────────────────────────────────────────────

const refsFromArgs = () => (arg('ref') || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * --approval standing|one-off, with its optional --scope. Returns the fields to merge into a row, or
 * nothing when the flag is absent. A value outside APPROVALS, or --scope without --approval, exits 1.
 */
function parseApproval(): { approval?: string; scope?: string } {
    const approval = arg('approval');
    if (has('approval') && !approval) die(`--approval needs a value: ${[...APPROVALS].join(' | ')}`);
    if (!approval) return has('scope') ? die('--scope only goes with --approval.') : {};
    if (!APPROVALS.has(approval)) die(`--approval must be one of: ${[...APPROVALS].join(', ')} (got "${approval}")`);
    return { approval, scope: arg('scope') || undefined };
}

/** parseApproval for a row of `kind`: --approval is only allowed on the kinds in APPROVAL_WRITE_KINDS. */
function approvalFor(kind: string) {
    const fields = parseApproval();
    if (fields.approval && !APPROVAL_WRITE_KINDS.has(kind)) die(`--approval only goes on: ${[...APPROVAL_WRITE_KINDS].join(', ')} (not ${kind}).`);
    return fields;
}

/** Absolute path of a ref that names an existing file (`~/` and relative paths allowed); null when it does not. */
function resolveRefFile(ref: string): string | null {
    const p = resolve(ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : ref);
    try { return statSync(p).isFile() ? p : null; } catch { return null; }
}

/**
 * The refs of a `rule` row, as absolute paths. A rule is a decision that has been promoted somewhere
 * durable (a memory file, a DECISIONS.md), so it needs at least one --ref and every one must be an
 * existing file; anything else exits 1 before the ledger is touched.
 */
function ruleRefs(): string[] {
    const refs = refsFromArgs();
    if (!refs.length) die('A rule needs --ref <file>: the memory file or DECISIONS.md entry it was promoted to. Use `ask --kind decision` for a decision that is still pending.');
    return refs.map((r) => resolveRefFile(r) || die(`--ref ${r} is not an existing file. Promote the rule first, then record it.`));
}

/**
 * `ask --paste <file>`: a run-this ask. The block file must exist (checked before anything is written), and the row
 * is boxed as a paste block, shown apart from the questions. Only a question can be one. Returns the absolute path.
 */
function pasteFile(kind: string): string | undefined {
    if (!has('paste')) return undefined;
    const given = arg('paste');
    if (!given) die('--paste needs a block file: journal.ts ask "<what to run>" --paste <file>');
    if (kind !== 'question') die('--paste only goes on a question.');
    return resolveRefFile(given) || die(`--paste ${given} is not an existing file. Write the block to a file first.`);
}

/**
 * `--gate gh:pr:<repo>#N | date:YYYY-MM-DD | ticket:<id>`: what a blocked item is waiting for. Only a `blocked` row
 * takes one, and a malformed gate exits 1 before anything is written, so `resume` never has to guess at it.
 */
function gateFlag(kind: string): string | undefined {
    if (!has('gate')) return undefined;
    const spec = arg('gate');
    if (!spec) die('--gate needs a value: gh:pr:<repo>#N | date:YYYY-MM-DD | ticket:<id>');
    if (kind !== 'blocked') die('--gate only goes on --kind blocked.');
    if (!parseGate(spec)) die(`--gate "${spec}" is not gh:pr:<repo>#N, date:YYYY-MM-DD or ticket:<id>.`);
    return spec;
}

/**
 * log, start, ask, note and rule. `ask` takes --kind question (default) or decision; a decision written by `ask`
 * is pending and stays on the board. `rule` always writes a decision, which is a record and not open.
 */
/** `--transitioned KEY[,KEY]` as a list of tracker keys, or undefined; a value that is not a key (tracker_key_pattern) is refused. */
function transitionedFlag(): string[] | undefined {
    const raw = arg('transitioned');
    if (raw === null) { if (has('transitioned')) die('--transitioned needs a value: one or more tracker keys, comma-separated.'); return undefined; }
    const keys = raw.split(',').map((k) => k.trim()).filter(Boolean);
    const whole = new RegExp(`^(?:${TRACKER_KEY_PATTERN})$`);
    const bad = keys.filter((k) => !whole.test(k));
    if (!keys.length || bad.length) die(`--transitioned needs tracker keys matching tracker_key_pattern, got: ${bad.join(', ') || raw}`);
    return keys;
}

function cmdLog(kindDefault = 'note', { ask = false, rule = false } = {}) {
    const text = arg('text') || positional.join(' ');
    if (!text) { console.error(`Needs text: journal.ts ${rule ? 'rule' : 'log'} "what happened"`); process.exit(1); }
    const kind = rule ? 'decision' : arg('kind', kindDefault);
    if (!KINDS.includes(kind)) { console.error(`kind must be one of: ${KINDS.join(', ')}`); process.exit(1); }
    if (ask && !['question', 'decision'].includes(kind)) die('ask takes --kind question (default) or decision.');
    const refs = rule ? ruleRefs() : refsFromArgs();
    const paste = ask ? pasteFile(kind) : undefined;
    const gate = gateFlag(kind);

    const entries = readLedger();
    const entry = {
        id: newId(entries),
        ts: now(),
        date: arg('date', today()),   // backdate when reconstructing
        kind,
        text,
        repo: arg('repo') || undefined,
        ticket: arg('ticket') || undefined,
        stream: streamOrNone(arg('stream')),
        refs,
        pending: ask && kind === 'decision' ? true : undefined,
        box: paste ? 'paste' : undefined,
        paste,
        gate,
        transitioned: transitionedFlag(),
        ...approvalFor(kind),
        ...usageFromArgs(),
    };
    append(entry);
    if (!dryRun) render(true);
    console.log(`${entry.kind}  ${entry.id}  ${entry.text}`);
    return entry;
}

/** `resolve` may carry an approval (the user answered an `ask` with one); other closers reject the flag. */
const approvalClose = (kind: string) => {
    const fields = approvalFor(kind);
    return fields.approval ? { ...fields, refs: refsFromArgs() } : {};
};

function cmdClose(newKind: string): void {
    const needle = positional[0];
    const { items } = fold(readLedger());
    const target = resolveTarget(items, needle);
    if (!target) { console.error(`No open item matching "${needle}".`); process.exit(1); }

    const entries = readLedger();
    const note = arg('answer') || arg('why') || null;
    append({
        id: newId(entries),
        ts: now(),
        date: today(),
        kind: newKind,
        closes: target.id,
        text: note || target.text,
        repo: target.repo,
        ticket: arg('ticket') || target.ticket,
        ...approvalClose(newKind),
        ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`${newKind}  ${target.id}  ${target.text}${note ? `\n      ${note}` : ''}`);
}

/** File an existing item under a workstream (or clear it with --stream none). */
function cmdTag() {
    const needle = positional[0];
    const stream = normaliseStream(arg('stream'));
    if (!needle || !stream) { console.error('Usage: journal.ts tag <id|text> --stream <name>'); process.exit(1); }
    const { items } = fold(readLedger());
    const target = items.find((i) => i.id === needle) || resolveTarget(items, needle);
    if (!target) { console.error(`No item matching "${needle}".`); process.exit(1); }
    const entries = readLedger();
    append({
        id: newId(entries),
        ts: now(),
        date: today(),
        kind: 'tag',
        tags: target.id,
        stream: stream === 'none' ? undefined : stream,
        text: `stream ${stream}`,
        ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`tag  ${target.id}  -> ${stream}  ${target.text}`);
}

/** Mark an existing row as an approval without rewriting the ledger: appends an `approval-tag` row. */
function cmdApproveTag() {
    const id = positional[0];
    const fields = parseApproval();
    if (!id || !fields.approval) die('Usage: journal.ts approve-tag <id> --approval standing|one-off [--scope ..] [--ref ..]');
    const entries = readLedger();
    const target = entries.find((e) => e.id === id && !e.annotates);
    if (!target) die(`No row with id "${id}".`);
    if (!APPROVABLE_KINDS.has(target.kind)) die(`Row ${id} is a ${target.kind}; only ${[...APPROVABLE_KINDS].join(', ')} rows can be approved.`);
    append({
        id: newId(entries),
        ts: now(),
        date: today(),
        kind: 'approval-tag',
        approves: target.id,
        text: `approval ${fields.approval}`,
        ...fields,
        refs: refsFromArgs(),
        ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`approval-tag  ${target.id}  -> ${fields.approval}  ${target.text}`);
}

// approvals digest ----------------------------------------------------------

function cmdApprovals() {
    const window = approvalsWindow({ arg, has, die, today });
    const g = collectApprovals(readLedger(), window);
    const week = isoWeek(window.until);
    if (asJson) { console.log(JSON.stringify({ ...window, week, ...g }, null, 2)); return; }
    const body = approvalsText(g, window, week, today);
    if (dryRun) { console.log(body); return; }
    const path = arg('out') || join(ticketsBase(), 'Projects', project, 'Reviews', `approvals-${week}.md`);
    if (existsSync(path) && !has('force')) die(`${path} already exists. Pass --force to overwrite it.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`wrote ${path}  (${g.standing.length} standing, ${g.oneOff.length} one-off, ${g.untagged.length} untagged)`);
}

function cmdStatus() {
    refreshBoard();
    const g = groups(has('include-archived'));
    const d = arg('date', today());
    const rolledAt = g.rollPointOn(d);
    const done = g.doneOn(d, { sinceRoll: true });

    if (asJson) {
        console.log(JSON.stringify({
            date: d,
            inflight: g.inflight, blocked: g.blocked, awaiting: g.awaiting, paste: g.paste, done,
        }, null, 2));
        return;
    }

    if (has('footer')) { [...footerLines(g, done), sessionLine(CLAUDE_PROJECTS_DIR)].forEach((l) => console.log(l)); return; }

    const line = (label: string, arr: LedgerItem[]): void => {
        if (!arr.length) return;
        console.log(`\n${label}`);
        arr.forEach((i) => console.log(`  ${fmt(i)}`));
    };
    console.log(`Ledger — ${d}`);
    const streams = activeStreams(g.inflight, g.blocked, g.awaiting, g.paste, done);
    for (const s of streams) {
        console.log(`\n== ${streamTitle(s)} ==`);
        line('In flight', inStream(g.inflight, s));
        line('Blocked', inStream(g.blocked, s));
        line('Awaiting you', inStream(g.awaiting, s));
        line('Paste blocks for you', inStream(g.paste, s));
        line(`Done ${d}`, inStream(done, s));
    }
    // Without this heading the unstreamed sections read as part of the last stream.
    if (streams.length && [g.inflight, g.blocked, g.awaiting, g.paste, done].some((arr) => noStream(arr).length)) console.log('\n== other ==');
    line('In flight', noStream(g.inflight));
    line('Blocked', noStream(g.blocked));
    line('Awaiting you', noStream(g.awaiting));
    line('Paste blocks for you', noStream(g.paste));
    line(`Done ${d}`, noStream(done));
    if (rolledAt) console.log(`\n  (${g.doneOn(d).length - done.length} earlier item(s) archived to ${d}.md)`);
    if (has('full')) line('Notes', g.notesOn(d));
    if (!g.inflight.length && !g.blocked.length && !g.awaiting.length && !g.paste.length && !done.length) {
        console.log('\n  (empty)');
    }
    console.log(`\n  ${done.length} done · ${g.inflight.length} in flight · ${g.awaiting.length} awaiting you${g.paste.length ? ` · ${g.paste.length} to run` : ''}${g.blocked.length ? ` · ${g.blocked.length} blocked` : ''}`);
}

function cmdStandup() {
    console.log(standupText(arg('date', today())));
}

/** With scripts_dir set, print the scratch triage table. Read-only: it proposes, the user decides. */
function cmdScratch() {
    if (!SCRIPTS_SHELF_DIR) { console.log('scratch: scripts_dir is not set; nothing to list.'); return; }
    scratchReport(SCRIPTS_SHELF_DIR, readLedger().map((e) => e.text || '')).forEach((l) => console.log(l));
}

/**
 * The worktree half of the branch sweep (branch-sweep.ts owns what qualifies; this only calls it): { result, dry }, or
 * null when skipped, refused or it failed (the reason is printed; a sweep problem never fails the roll or the handoff).
 * It scans only the configured container_root, and only when run from inside it (the cwd, or --container as a stand-in
 * for it): a sweep that follows whatever directory the shell happens to be in can remove worktrees of an unrelated tree.
 */
function runWorktreeSweep(dry: boolean) {
    if (has('no-worktree-sweep')) return null;
    const refusal = sweepRootRefusal(CONTAINER_ROOT, resolve(arg('container', process.cwd())));
    if (refusal) { console.log(`worktree sweep refused: ${refusal}`); return null; }
    try {
        return sweepWorktrees(realpathSync(CONTAINER_ROOT), defaultContext({ claimsDir, worktreesOnly: true }), { dryRun: dry, budgetSeconds: SWEEP_BUDGET_SECONDS });
    } catch (e) {
        console.log(`worktree sweep skipped: ${errorMessage(e)}`);
        return null;
    }
}

/** Why the sweep must not run, or '' when `from` is inside the configured `root`. Paths are compared by real path. */
function sweepRootRefusal(root: string, from: string): string | null {
    if (!root) return 'container_root is not set (config key container_root or MAESTRO_CONTAINER_ROOT). Set it to the directory holding your repos, or pass --no-worktree-sweep.';
    if (!existsSync(root)) return `container_root ${root} does not exist.`;
    if (!existsSync(from)) return `no such directory ${from}.`;
    const rel = relative(realpathSync(root), realpathSync(from));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${from} is outside container_root ${root}. Run it from inside the container.`;
    return '';
}

/**
 * Roll's sweep: removes every worktree that qualifies (a standing approval), prunes entries whose directory is missing,
 * and prints what went and what stayed with reasons. It runs even when there is nothing to archive. --dry-run only reports.
 */
function sweepWorktreesForRoll() {
    const result = runWorktreeSweep(dryRun);
    if (result) console.log(worktreeSweepLines(result, dryRun, { verbose: has('verbose') }).join('\n'));
}

/**
 * Compression, in the order that keeps the ledger safe: triage, archive, commit, and only then the worktree sweep.
 * The sweep is the slow part (it talks to git remotes), so it runs last and a slow or failed one never delays or
 * blocks the archive. `roll --fast` skips it (and the scratch review the caller runs afterwards).
 */
function cmdRoll() {
    const d = arg('date', today());
    triageBeforeRoll(d);
    rollArchive(d);
    if (!has('fast')) sweepWorktreesForRoll();
}

/**
 * Writes the day's finished work to a dated note and drops it out of CURRENT.md, leaving a link. Open items are NOT
 * archived: they stay visible until they are actually closed. Commits the ledger when ledger_git_autocommit is on.
 */
function rollArchive(d: string): void {
    const g = groups();
    const done = g.doneOn(d);
    const notes = g.notesOn(d);

    if (!done.length && !notes.length) {
        console.log(`Nothing finished on ${d} to archive.`);
        return;
    }

    const dest = join(dir, `${d}.md`);
    const body = [
        '---',
        `date: ${d}`,
        'type: journal',
        '---',
        '',
        standupText(d),
        '',
        '---',
        '',
        `_Archived from the working ledger. Still-open items stay in [[CURRENT]]._`,
        '',
    ].join('\n');

    if (dryRun) { console.log(body); return; }
    ensureDir();
    writeFileSync(dest, body);
    append({
        id: newId(readLedger()), ts: now(), date: d, kind: 'rolled', text: `archived ${done.length} item(s)`,
        model: 'n/a', used: ['tool:journal.ts'], tokens: 'n/a',
    });
    render(true);
    console.log(`archived ${done.length} finished item(s) -> ${dest}`);
    console.log(`kept open: ${g.inflight.length} in flight, ${g.awaiting.length} awaiting you${g.paste.length ? `, ${g.paste.length} paste block(s)` : ''}`);
    if (!autoCommitLedger(d)) process.exitCode = 1;
}

// ── boxes and triage ────────────────────────────────────────────────────────


/**
 * `triage [--date D] [--since D] [--json]` is read-only. `--apply` appends a `resolved` row ("recorded → <ref>") for
 * each rule or approval (boxes 1 to 3) whose ref is an existing file, and nothing else; it never closes an item
 * with no resolvable ref. Closed items fall out of scope, so a second run appends nothing.
 */
function cmdTriage() {
    const d = arg('date', today());
    const since = arg('since', d);
    if (!isDate(d) || !isDate(since)) die('--date and --since must be YYYY-MM-DD.');
    // --apply closes records, so it only ever looks at today's: --since widens the report, never the closing.
    const t = triageReport(d, has('apply') ? d : since);
    if (has('apply')) {
        const entries = readLedger();
        const taken = [...entries];
        const rows = t.items.flatMap((i) => (RECORD_BOXES.includes(i.box) && i.ref ? [{ item: i, ref: i.ref }] : [])).map(({ item, ref }) => {
            const row: LedgerRow = {
                id: newId(taken), ts: now(), date: d, kind: 'resolved', closes: item.id, text: `recorded → ${ref}`, refs: [ref],
                model: 'n/a', used: ['tool:journal.ts'], tokens: 'n/a',
            };
            taken.push(row);
            return row;
        });
        appendMany(rows);
        if (!dryRun && rows.length) render(true);
        if (asJson) console.log(JSON.stringify({ applied: rows.map((r) => ({ id: r.closes, ref: r.refs?.[0] })), report: { ...t, items: undefined, byBox: undefined } }, null, 2));
        else console.log(`triage --apply: closed ${rows.length} recorded item(s)${dryRun ? ' (dry-run)' : ''}; ${t.items.filter((i) => RECORD_BOXES.includes(i.box) && !i.ref).length} still need a ref file.`);
        return;
    }
    if (asJson) { console.log(JSON.stringify(t, null, 2)); return; }
    triageLines(t).forEach((l) => console.log(l));
}

/** roll's gate: warns about triage blockers, or with --strict prints them and exits 1 before anything is changed. */
function triageBeforeRoll(d: string): void {
    const { blockers } = triageReport(d);
    if (!blockers.length) return;
    const lines = blockers.map((b) => `  ${b.id}  box ${b.box}: ${b.why}`);
    if (has('strict')) {
        console.error(`roll --strict refused: triage has ${blockers.length} blocker(s). Nothing was archived or removed.`);
        lines.forEach((l) => console.error(l));
        console.error('Run `journal.ts triage`, fix them (promote the rule, file the ticket), then roll again.');
        process.exit(1);
    }
    console.log(`warning: triage has ${blockers.length} blocker(s) (roll --strict would refuse):`);
    lines.forEach((l) => console.log(l));
}

// ── verify and the ledger backup commit ─────────────────────────────────────

function cmdVerify() {
    const { rows, problems } = verifyLedger();
    if (asJson) console.log(JSON.stringify({ ledger: ledgerPath, rows, problems }, null, 2));
    else {
        console.log(`verify: ${rows} row(s), ${problems.length} problem(s)  (${ledgerPath})`);
        problems.slice(0, 50).forEach((p) => console.log(`  line ${p.line}${p.id ? ` [${p.id}]` : ''}: ${p.problem}`));
        if (problems.length > 50) console.log(`  ... and ${problems.length - 50} more`);
    }
    if (problems.length) process.exit(1);
}

/** Annotate one existing entry (an item or a closing row) without rewriting the JSONL. */
function cmdStamp() {
    const needle = positional[0];
    const entries = readLedger();
    const target = entries.find((e) => e.id === needle && !e.annotates)
        || resolveTarget(fold(entries).items, needle);
    if (!target) { console.error(`No entry matching "${needle}".`); process.exit(1); }
    append({
        id: newId(entries), ts: now(), date: today(), kind: 'stamp', annotates: target.id,
        text: `stamp ${target.id}`, ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`stamp  ${target.id}  ${target.text}`);
}

/**
 * Mark every entry that has no model or no used. Only missing fields are
 * written, and an entry already marked is skipped, so re-running is a no-op.
 */
function cmdStampMissing() {
    const entries = readLedger();
    const marks = new Map<string, ReturnType<typeof mergeMark>>();
    for (const e of entries) if (e.annotates) marks.set(e.annotates, mergeMark(marks.get(e.annotates), e));
    const fill = {
        model: normaliseModel(arg('model', 'unrecorded')),
        used: parseList('used') || ['unrecorded'],
        tokens: arg('tokens', 'unmeasured'),
    };
    const FILL_FIELDS: (keyof typeof fill)[] = ['model', 'used', 'tokens'];
    const taken = [...entries];
    let count = 0;
    for (const e of entries) {
        if (!e.id || e.annotates || e.kind === 'stamp') continue;
        const cur = { ...e, ...(marks.get(e.id) || {}) };
        if (cur.model && cur.used) continue;
        const add: Record<string, unknown> = {};
        for (const f of FILL_FIELDS) if (cur[f] === undefined) add[f] = fill[f];
        const row: LedgerRow = { id: newId(taken), ts: now(), date: today(), kind: 'stamp', annotates: e.id, text: `stamp ${e.id}`, ...add };
        taken.push(row);
        append(row);
        count++;
    }
    if (!dryRun && count) render(true);
    console.log(`stamped ${count} entr${count === 1 ? 'y' : 'ies'}${dryRun ? ' (dry-run)' : ''}`);
}

function cmdUsage() {
    const { items } = fold(readLedger());
    const pool = has('open') ? items.filter(isOpen) : items;
    const models = new Map<string, number>();
    const used = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) || 0) + 1); };
    for (const i of pool) {
        bump(models, i.model || 'unrecorded');
        // Marks are coerced to strings on read, so a hand-edited numeric mark (1) and its string form ("1") are one row on
        // purpose. journal only writes string marks; stored rows are never rewritten.
        const marks = (Array.isArray(i.used) ? i.used : [i.used || 'unrecorded']).map(String);
        marks.forEach((x) => bump(used, x));
    }
    const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]);
    if (asJson) {
        console.log(JSON.stringify({ items: pool.length, model: Object.fromEntries(sorted(models)), used: Object.fromEntries(sorted(used)) }, null, 2));
        return;
    }
    console.log(`Usage marks — ${pool.length} item(s)${has('open') ? ' open' : ''}`);
    console.log('\nModel');
    sorted(models).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
    console.log('\nUsed');
    sorted(used).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
}

// ── streams, facts, carry, retro, archive ───────────────────────────────────

function die(msg: string): never { console.error(msg); process.exit(1); }
const tally = (items: LedgerItem[]) => ({
    open: items.filter(isOpen).length,
    done: items.filter((i) => i.state === 'done').length,
    dropped: items.filter((i) => i.state === 'dropped').length,
    total: items.length,
});

/** Canonical stream for a command argument; unknown to both registry and ledger is an error. */
function existingStream(name: string | null | undefined, items: LedgerItem[]): string {
    if (!name) die('Needs a stream name.');
    // `none` maps to no stream; the callers only pass names that exist, so a stream is there once this returns.
    const stream = mapStream(name) as string;
    if (!items.some((i) => i.stream === stream) && !loadRegistry()?.streams[stream]) {
        die(`No stream "${name}" in the registry or the ledger.`);
    }
    return stream;
}

function cmdStreams() {
    const sub = positional[0] || 'list';
    const reg = loadRegistry();
    const { items } = fold(readLedger());
    if (sub === 'list') {
        const seen = [...new Set(items.flatMap((i) => (i.stream ? [i.stream] : [])))];
        const names = [...new Set([...Object.keys(reg?.streams || {}), ...seen])];
        const rows = names.map((name) => ({
            stream: name,
            status: reg?.streams[name]?.status || (reg ? 'unregistered' : '(no registry)'),
            aliases: reg?.streams[name]?.aliases || [],
            ...tally(items.filter((i) => i.stream === name)),
        }));
        if (asJson) { console.log(JSON.stringify({ registry: reg ? registryPath : null, streams: rows }, null, 2)); return; }
        console.log(reg ? `Registry: ${registryPath}` : `No registry at ${registryPath} (streams are free text).`);
        for (const r of rows) {
            console.log(`  ${r.stream}  [${r.status}]  open ${r.open} · done ${r.done} · dropped ${r.dropped} · total ${r.total}${r.aliases.length ? `  aliases: ${r.aliases.join(', ')}` : ''}`);
        }
        return;
    }
    if (sub === 'add') {
        const name = positional[1];
        if (isNoStream(name)) die('"none" is reserved: it means no stream, so it cannot be registered.');
        if (!name) die('Usage: journal.ts streams add <name> [--alias a,b]');
        const aliases = parseList('alias') || [];
        const next: Registry = { models: undefined, ...(reg || {}), hasStreams: true, streams: { ...(reg?.streams || {}) } };
        const owner = canonicalOf(next, name);
        if (owner && owner !== name) die(`"${name}" is already registered as "${owner}" (name or alias, case-insensitive).`);
        const existing = next.streams[name];
        const entry = { status: 'active', ...(existing || {}), aliases: [...(existing?.aliases || [])] };   // a hand-edited entry without an aliases list counts as empty
        const aliasesOf = entry.aliases;
        for (const a of aliases) {
            const other = canonicalOf(next, a);
            if (other && other !== name) die(`Alias "${a}" already belongs to "${other}".`);
            if (a.toLowerCase() !== name.toLowerCase() && !aliasesOf.some((x) => String(x).toLowerCase() === a.toLowerCase())) aliasesOf.push(a);
        }
        next.streams[name] = entry;
        const changed = !existing || (existing.aliases?.length ?? 0) !== aliasesOf.length;
        if (changed && !dryRun) saveRegistry(next);
        console.log(`${changed ? (reg?.streams[name] ? 'updated' : 'added') : 'unchanged'}  ${name}  aliases: ${aliasesOf.join(', ') || '(none)'}${dryRun && changed ? ' (dry-run)' : ''}`);
        return;
    }
    if (sub === 'check') {
        // Phase 2a dry run: how many rows would change display stream under the mapping. Appends nothing.
        const entries = readLedger();
        const raw = fold(entries).items;
        const rawStreams = new Map<string | undefined, string | undefined>();
        for (const e of entries) {
            if (e.id && !e.closes && !e.annotates && !NON_ITEM_KINDS.includes(e.kind ?? '')) rawStreams.set(e.id, e.stream);
            if ((e.kind === 'tag' && e.tags) || (e.kind === 'carry' && e.carries)) rawStreams.set(e.tags || e.carries, e.stream || undefined);
        }
        const changes = new Map<string, number>();
        for (const i of raw) {
            const before = rawStreams.get(i.id);
            if (before && before !== i.stream) changes.set(`${before} -> ${i.stream}`, (changes.get(`${before} -> ${i.stream}`) || 0) + 1);
        }
        const rowsWithOldSpelling = entries.filter((e) => e.stream && mapStream(e.stream) !== e.stream).length;
        const total = [...changes.values()].reduce((a, b) => a + b, 0);
        if (asJson) { console.log(JSON.stringify({ items: total, rows: rowsWithOldSpelling, changes: Object.fromEntries(changes) }, null, 2)); return; }
        console.log(`${total} item(s) would change display stream (${rowsWithOldSpelling} ledger row(s) carry a non-canonical spelling); nothing appended.`);
        for (const [k, n] of changes) console.log(`  ${String(n).padStart(4)}  ${k}`);
        return;
    }
    die('Usage: journal.ts streams [list|add <name> [--alias a,b]|check]');
}

/** A structured metric for a stream. Not an item: it never shows as open and never reaches the board. */
function cmdFact() {
    const pair = arg('text') || positional.join(' ');
    const eq = pair.indexOf('=');
    if (eq < 1) die('Usage: journal.ts fact <key>=<value> --stream <name>');
    if (!arg('stream') || isNoStream(arg('stream'))) die('fact needs --stream <name>.');
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const entries = readLedger();
    const entry = {
        id: newId(entries), ts: now(), date: arg('date', today()), kind: 'fact', key, value, text: `${key}=${value}`,
        stream: normaliseStream(arg('stream')), ticket: arg('ticket') || undefined, repo: arg('repo') || undefined,
        ...usageFromArgs(),
    };
    append(entry);
    if (!dryRun) render(true);
    console.log(`fact  ${entry.id}  ${entry.text}  (${entry.stream})`);
}

/** Re-home an item to another stream, keeping the old one in `from` so a retro can say where it went. */
function cmdCarry() {
    const needle = positional[0];
    const to = arg('to');
    if (!needle || !to) die('Usage: journal.ts carry <id|text> --to <stream>');
    const { items } = fold(readLedger());
    const target = items.find((i) => i.id === needle) || resolveTarget(items, needle);
    if (!target) die(`No item matching "${needle}".`);
    const stream = normaliseStream(to);
    if (stream === 'none') die('carry needs a real stream; use `tag --stream none` to clear one.');
    const entries = readLedger();
    append({
        id: newId(entries), ts: now(), date: today(), kind: 'carry', carries: target.id,
        from: target.stream, stream, text: `carry ${target.stream || '(none)'} -> ${stream}`,
        ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`carry  ${target.id}  ${target.stream || '(none)'} -> ${stream}  ${target.text}`);
}

// models -------------------------------------------------------------------

/** The `models` section of the registry: canonical id plus aliases. Dry run by design for `check`. */
function cmdModels() {
    const sub = positional[0] || 'list';
    const reg = loadRegistry();
    const entries = readLedger();
    const rowCounts = new Map();
    for (const e of entries) if (e.model) rowCounts.set(e.model, (rowCounts.get(e.model) || 0) + 1);

    if (sub === 'list') {
        const models = reg?.models || {};
        const rows = Object.entries(models).map(([id, meta]) => ({
            model: id,
            aliases: meta?.aliases || [],
            rows: [...rowCounts].filter(([raw]) => canonicalModel(reg, raw) === id).reduce((a, [, n]) => a + n, 0),
        }));
        if (asJson) { console.log(JSON.stringify({ registry: reg?.models ? registryPath : null, models: rows }, null, 2)); return; }
        console.log(reg?.models ? `Model registry: ${registryPath}` : `No models section in ${registryPath} (model names are free text).`);
        for (const r of rows) console.log(`  ${r.model}  rows ${r.rows}${r.aliases.length ? `  aliases: ${r.aliases.join(', ')}` : ''}`);
        return;
    }
    if (sub === 'add') {
        const id = positional[1];
        if (!id) die('Usage: journal.ts models add <canonical-id> [--alias a,b]');
        const next = { streams: {}, hasStreams: false, ...(reg || {}), models: { ...(reg?.models || {}) } };
        const owner = canonicalModel(next, id);
        if (owner && owner !== id) die(`"${id}" is already registered as "${owner}" (id or alias, case-insensitive).`);
        const entry = { aliases: [...(next.models[id]?.aliases || [])] };
        for (const a of parseList('alias') || []) {
            const other = canonicalModel(next, a);
            if (other && other !== id) die(`Alias "${a}" already belongs to "${other}".`);
            if (a.toLowerCase() !== id.toLowerCase() && !entry.aliases.some((x) => String(x).toLowerCase() === a.toLowerCase())) entry.aliases.push(a);
        }
        next.models[id] = entry;
        const changed = JSON.stringify(reg?.models?.[id]) !== JSON.stringify(entry);
        if (changed && !dryRun) saveRegistry(next);
        console.log(`${changed ? (reg?.models?.[id] ? 'updated' : 'added') : 'unchanged'}  ${id}  aliases: ${entry.aliases.join(', ') || '(none)'}${dryRun && changed ? ' (dry-run)' : ''}`);
        return;
    }
    if (sub === 'check') {
        // Dry run: every model spelling in the ledger, what it maps to, and which are unknown. Appends nothing.
        const rows = [...rowCounts].sort((a, b) => b[1] - a[1]).map(([raw, n]) => {
            const canon = canonicalModel(reg, raw);
            const status = MODEL_SENTINELS.has(raw) ? 'sentinel' : !reg?.models ? 'no registry' : !canon ? 'unknown' : canon === raw ? 'canonical' : 'alias';
            return { model: raw, rows: n, canonical: canon, status };
        });
        const would = rows.filter((r) => r.status === 'alias');
        if (asJson) { console.log(JSON.stringify({ rows: would.reduce((a, r) => a + r.rows, 0), models: rows }, null, 2)); return; }
        console.log(`${would.reduce((a, r) => a + r.rows, 0)} row(s) would show under a different model name; nothing appended.`);
        for (const r of rows) console.log(`  ${String(r.rows).padStart(5)}  ${r.model}  [${r.status}]${r.status === 'alias' ? ` -> ${r.canonical}` : ''}`);
        return;
    }
    die('Usage: journal.ts models [list|add <canonical-id> [--alias a,b]|check]');
}

// retro --------------------------------------------------------------------

const ticketsBase = () => {
    const base = arg('tickets-vault') || VAULT_ROOT;
    if (!base) {
        console.error('Tickets vault is not set. Set VAULT_ROOT or pass --tickets-vault <path>.');
        process.exit(1);
    }
    return base;
};
const retroDir = () => join(ticketsBase(), 'Projects', arg('repo') || 'dev-env', 'Archive');
const retroCtx = () => ({ vault, project, ticketsBase, readLedger, fold, mapStream, today, arg, retroDir, ticketStatuses });
const retroText = (stream: string) => retroTextIn(retroCtx(), stream);
const ticketStatuses = (ids: string[]) => ticketStatusesIn(retroCtx(), ids);
const findRetro = (stream: string) => findRetroIn(retroCtx(), stream);
const archiveBlockers = (stream: string, items: LedgerItem[]) => archiveBlockersIn(retroCtx(), stream, items);

function cmdRetro() {
    const { items } = fold(readLedger());
    const stream = existingStream(positional[0], items);
    const path = arg('out') || join(retroDir(), `${slug(stream)}-retro-${today()}.md`);
    if (existsSync(path) && !has('force')) die(`${path} already exists. Pass --force to overwrite it.`);
    const body = retroText(stream);
    if (dryRun) { console.log(body); return; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`wrote ${path}`);
}

// archive ------------------------------------------------------------------

function cmdArchive() {
    const { items, archivedStreams } = fold(readLedger());
    const stream = existingStream(positional[0], items);
    if (archivedStreams.has(stream)) die(`${stream} is already archived.`);
    const { blockers, retro } = archiveBlockers(stream, items);
    if (blockers.length) {
        console.error(`Cannot archive ${stream}:`);
        blockers.forEach((b) => console.error(`  - ${b}`));
        process.exit(1);
    }
    const ids = items.filter((i) => i.stream === stream).map((i) => i.id);
    const entries = readLedger();
    append({
        id: newId(entries), ts: now(), date: today(), kind: 'archive', stream, ids, retro,
        text: `archived stream ${stream} (${ids.length} items)`, ...usageFromArgs(),
    });
    if (!dryRun) { setRegistryStatus(stream, 'archived'); render(true); }
    console.log(`archive  ${stream}  ${ids.length} item(s) hidden; retro ${retro}`);
}

function cmdUnarchive() {
    const { items, archivedStreams } = fold(readLedger());
    const stream = existingStream(positional[0], items);
    if (!archivedStreams.has(stream)) die(`${stream} is not archived.`);
    const entries = readLedger();
    const last = entries.filter((e) => e.kind === 'archive' && mapStream(e.stream) === stream).pop();
    append({
        id: newId(entries), ts: now(), date: today(), kind: 'unarchive', stream, ids: last?.ids || [],
        text: `unarchived stream ${stream}`, ...usageFromArgs(),
    });
    if (!dryRun) { setRegistryStatus(stream, 'active'); render(true); }
    console.log(`unarchive  ${stream}  ${(last?.ids || []).length} item(s) restored`);
}

function setRegistryStatus(stream: string, status: string): void {
    const reg = loadRegistry();
    if (!reg) { console.error(`  (no registry; ${stream} not marked ${status} there)`); return; }
    reg.streams[stream] = { aliases: [], ...(reg.streams[stream] || {}), status };
    saveRegistry(reg);
}

// ── repo claims ─────────────────────────────────────────────────────────────

const claimsDir = join(vault, 'Projects', project, 'Claims');
const claimPath = (repo: string) => claimPathIn(claimsDir, repo);
const validRepo = (r: string | undefined) => validRepoIn(die, r);
const readClaim = (repo: string) => readClaimIn(claimsDir, repo);

function cmdClaim() {
    const repo = validRepo(positional[0]);
    const deskArg = arg('desk');
    if (!deskArg) die('Usage: journal.ts claim <repo> --desk <stream> [--branch b] [--why "..."] [--pid n]');
    const desk = normaliseStream(deskArg);
    const usage = usageFromArgs();
    const pid = arg('pid') ? Number(arg('pid')) : null;
    if (arg('pid') && !Number.isInteger(pid)) die('--pid must be an integer.');
    const claim = { repo, desk, pid, host: hostname(), time: now(), branch: arg('branch') || undefined, why: arg('why') || undefined };
    if (dryRun) { console.log('[dry-run]', JSON.stringify(claim)); return; }
    const linkError = acquireClaimLock(claimsDir, repo, claim);
    if (linkError) {
        if (!('code' in linkError && linkError.code === 'EEXIST')) throw linkError;
        const held = readClaim(repo);
        console.error(`${repo} is already claimed by ${describeClaim(held)}.${held && claimStaleness(held, Number(arg('stale-hours', '12'))).stale ? ' It looks stale: `release --force` it if you are sure.' : ''}`);
        process.exit(1);
    }
    append({ id: newId(readLedger()), ts: claim.time, date: today(), kind: 'claim', repo, stream: desk, desk, branch: claim.branch, text: `claim ${repo} for ${desk}${claim.why ? `: ${claim.why}` : ''}`, ...usage });
    if (!dryRun) render(true);
    console.log(`claim  ${repo}  ${desk}`);
}

function cmdRelease() {
    const repo = validRepo(positional[0]);
    const held = readClaim(repo);
    if (!existsSync(claimPath(repo))) die(`${repo} is not claimed.`);
    const desk = arg('desk') ? normaliseStream(arg('desk')) : null;
    if (!has('force') && (!desk || !held || held.desk !== desk)) {
        die(`${repo} is held by ${describeClaim(held)}. Only that desk can release it (pass --desk), or use --force.`);
    }
    const usage = usageFromArgs();
    if (dryRun) { console.log(`[dry-run] release ${repo}`); return; }
    unlinkSync(claimPath(repo));
    append({ id: newId(readLedger()), ts: now(), date: today(), kind: 'released', repo, stream: held?.desk, desk: held?.desk, text: `released ${repo} (${held?.desk ?? 'unknown desk'})${has('force') ? ' with --force' : ''}`, ...usage });
    if (!dryRun) render(true);
    console.log(`released  ${repo}  ${held?.desk ?? ''}`);
}

function cmdClaims() {
    const hours = Number(arg('stale-hours', '12'));
    const files = existsSync(claimsDir) ? readdirSync(claimsDir).filter((n) => n.endsWith('.lock')).sort() : [];
    const rows = files.map((n) => {
        const repo = n.slice(0, -5);
        const c = readClaim(repo);
        const st = claimStaleness(c, hours);
        return { repo, desk: c?.desk ?? null, pid: c?.pid ?? null, host: c?.host ?? null, time: c?.time ?? null, branch: c?.branch ?? null, ageHours: Number.isFinite(st.ageHours) ? Math.round(st.ageHours * 10) / 10 : null, stale: st.stale, reason: st.reason };
    });
    if (asJson) { console.log(JSON.stringify({ staleHours: hours, claims: rows }, null, 2)); return; }
    if (!rows.length) { console.log('No claims.'); return; }
    for (const r of rows) console.log(`  ${r.repo}  desk ${r.desk ?? '?'}  pid ${r.pid ?? 'unknown'}  ${r.host ?? '?'}  ${r.ageHours ?? '?'}h${r.branch ? `  ${r.branch}` : ''}${r.stale ? `  STALE (${r.reason})` : ''}`);
}

// ── backfill ────────────────────────────────────────────────────────────────

const backfillProposals = () => backfillProposalsIn({ readLedger, fold, loadRegistry });
const handoffCtx = () => ({ fold, readLedger, today, claudeProjectsDir: CLAUDE_PROJECTS_DIR });
const handoffText = (stream: string | null, since: string, keptWorktrees?: Parameters<typeof handoffTextIn>[3], opts?: Parameters<typeof handoffTextIn>[4]) => handoffTextIn(handoffCtx(), stream, since, keptWorktrees, opts);
const updateContextLink = (file: string, handoffPath: string) => updateContextLinkIn(handoffCtx(), file, handoffPath);

function cmdBackfill() {
    const minConf = arg('min-confidence', 'high');
    if (!CONF.includes(minConf)) die(`--min-confidence must be one of: ${CONF.join(', ')}`);
    const { proposals, untagged } = backfillProposals();
    type Proposed = (typeof proposals)[number];
    // A proposal with a stream always has a confidence; a tie has neither.
    const proposed = proposals.filter((p): p is Proposed & { stream: string; confidence: string } => Boolean(p.stream));
    const apply = has('apply');
    const selected = proposed.filter((p) => CONF.indexOf(p.confidence) >= CONF.indexOf(minConf));

    if (apply) {
        const entries = readLedger();
        const runId = `bf-${newId(entries)}`;
        const taken = [...entries];
        const rows = selected.map((p) => {
            const row: LedgerRow = {
                id: newId(taken), ts: now(), date: today(), kind: 'tag', tags: p.item.id, stream: p.stream,
                text: `stream ${p.stream} (backfill)`, backfill: runId, rule: p.rules.join('+'), confidence: p.confidence, prev: p.item.stream ?? null,
                ...usageFromArgs(),
            };
            taken.push(row);
            return row;
        });
        appendMany(rows);
        if (!dryRun && rows.length) render(true);
        console.log(`backfill ${runId}: ${rows.length} tag row(s) at min-confidence ${minConf}${dryRun ? ' (dry-run)' : ''}`);
        return;
    }

    const groups = new Map<string, Record<string, Proposed[]>>();
    for (const p of proposed) {
        const g = groups.get(p.stream) || { high: [], medium: [], low: [] };
        g[String(p.confidence)].push(p);
        groups.set(p.stream, g);
    }
    const perStream = [...groups].map(([stream, g]) => ({ stream, high: g.high.length, medium: g.medium.length, low: g.low.length, total: g.high.length + g.medium.length + g.low.length }))
        .sort((a, b) => b.total - a.total);
    const perConf = Object.fromEntries(CONF.slice().reverse().map((c) => [c, proposed.filter((p) => p.confidence === c).length]));
    const noProposal = proposals.length - proposed.length;
    const nSamples = Number(arg('samples', '3'));
    const sample = (p: Proposed): string => `${p.item.id}  ${clip(p.item.text, 90)}  [${p.rules.join('+')}${p.item.repo ? `; repo ${p.item.repo}` : ''}]`;

    const outPath = arg('out');
    if (outPath) {
        const table = ['| id | date | kind | repo | ticket | proposed | confidence | rules |', '|---|---|---|---|---|---|---|---|',
            ...proposals.map((p) => `| ${p.item.id} | ${p.item.date} | ${p.item.kind} | ${cell(p.item.repo)} | ${cell(p.item.ticket)} | ${p.stream || ''} | ${p.confidence || ''} | ${p.rules.join('+')} |`)];
        writeFileSync(outPath, ['---', 'type: backfill-report', `generated: ${today()}`, '---', '', '# Backfill dry run', '', ...table, ''].join('\n'));
    }
    if (asJson) {
        console.log(JSON.stringify({ untagged, proposed: proposed.length, noProposal, byConfidence: perConf, byStream: perStream }, null, 2));
        return;
    }
    console.log(`Backfill dry run: ${untagged} untagged item(s); ${proposed.length} with a proposal, ${noProposal} with none. Nothing appended.`);
    console.log(`By confidence: high ${perConf.high} · medium ${perConf.medium} · low ${perConf.low}`);
    console.log('\nBy proposed stream:');
    for (const s of perStream) console.log(`  ${s.stream}  high ${s.high} · medium ${s.medium} · low ${s.low}  (${s.total})`);
    if (nSamples > 0) {
        console.log(`\nSamples (up to ${nSamples} per group):`);
        for (const s of perStream) for (const c of CONF.slice().reverse()) {
            const list = groups.get(s.stream)?.[c] ?? [];
            if (!list.length) continue;
            console.log(`  ${s.stream} / ${c}`);
            list.slice(0, nSamples).forEach((p) => console.log(`    ${sample(p)}`));
        }
    }
    console.log(`\nApply with: backfill --apply --min-confidence high (${selected.length} row(s) at high) after review.`);
}

// ── handoff and resume ──────────────────────────────────────────────────────

/** A free-text flag as one line (newlines folded to spaces), '' when absent: it lands inside a markdown list or paragraph. */
const oneLineArg = (name: string): string => (arg(name, '') || '').replace(/\s+/g, ' ').trim();

function cmdHandoff() {
    const { items } = fold(readLedger());
    const stream = has('all') ? null : existingStream(arg('stream'), items);
    const since = arg('since', yesterday());
    const streamSlug = stream === null ? 'all' : slug(stream);
    const series = has('delta') && !arg('out') ? handoffSeries(dir, today(), streamSlug) : null;
    if (series && series.prev && !series.next) die(`--delta: handoff suffixes b..z for ${today()} are used up; start a fresh session.`);
    const path = arg('out') || join(dir, series?.next ?? `HANDOFF-${today()}-${streamSlug}.md`);
    const marker = series?.prev ? handoffMarker(join(dir, series.prev)) : null;
    if (series?.prev && !marker) die(`--delta: ${series.prev} has no generated_at marker (written by an older version); run a full handoff with --force instead.`);
    if (series?.prev && marker) {
        if (arg('learn') || arg('next') || has('update-context')) die('--delta writes only the changes; --learn, --next and --update-context belong on the first (full) handoff of the day.');
        const body = handoffDeltaText(handoffCtx(), stream, marker, series.prev);
        if (dryRun) { console.log(body); return; }
        writeFileSync(path, body);
        console.log(`wrote ${path} (delta since ${marker})`);
        return;
    }
    if (existsSync(path) && !has('force')) die(`${path} already exists. Pass --force to overwrite it, or --out <path>.`);
    const sweep = runWorktreeSweep(true);
    const body = handoffText(stream, since, sweep?.kept, { learn: oneLineArg('learn'), next: oneLineArg('next'), sweep, verbose: has('verbose') });
    const contextFile = has('update-context') ? arg('context-file') || join(ticketsBase(), 'Projects', project, 'CONTEXT.md') : '';
    if (dryRun) { console.log(body); if (contextFile) console.log(`would point ${contextFile} at ${basename(path)}`); return; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`wrote ${path}`);
    if (contextFile) updateContextLink(contextFile, path);
}

/** Runs a command; { ok, out } where ok is false when it is missing or exits non-zero. */
const tryRun: TryRun = (cmdName, args) => {
    const r = spawnSync(cmdName, args, { encoding: 'utf8' });
    return { ok: !r.error && r.status === 0, missing: Boolean(r.error), out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

function cmdResume() {
    console.log('== Verify on resume ==');
    console.log('\n1. Ledger');
    cmdStatus();

    console.log('\n2. Open PRs (gh)');
    if (!RESUME_GH) console.log('  skipped: resume_gh is off in the config');
    else {
        const r = tryRun('gh', ['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,url']);
        if (r.missing) console.log('  gh: unavailable (not installed)');
        else if (!r.ok) console.log(`  gh: unavailable (${clip(r.err, 120) || 'gh exited non-zero'})`);
        else {
            let prs: { number: number; title: string; url: string }[] = [];
            try { prs = JSON.parse(r.out || '[]'); } catch { /* fall through to the count */ }
            console.log(`  ${prs.length} open`);
            prs.forEach((p) => console.log(`  #${p.number} ${p.title} ${p.url}`));
        }
    }

    console.log('\n3. Gates');
    const gates = gateReport();
    if (!gates.length) console.log('  none: no blocked item carries a --gate');
    for (const gt of gates) {
        const tag = { cleared: 'CLEARED', waiting: 'waiting', unknown: 'UNKNOWN' }[gt.state];
        console.log(`  ${tag.padEnd(8)} ${gt.item.id} ${clip(gt.item.text, 80)} (${gt.item.gate}: ${gt.detail})`);
        if (gt.state === 'cleared') console.log(`           the gate is clear: \`journal.ts resolve ${gt.item.id} --answer "gate cleared"\` then \`start\` it again`);
    }

    console.log('\n4. Loops (pgrep)');
    if (!LOOP_PATTERNS.length) console.log('  none configured (set loop_patterns in the config)');
    for (const pattern of LOOP_PATTERNS) {
        const r = tryRun('pgrep', ['-f', pattern]);
        if (r.missing) console.log(`  ${pattern}: pgrep unavailable`);
        else console.log(r.ok ? `  ok       ${pattern} (pid ${r.out.split('\n').join(', ')})` : `  MISSING  ${pattern}`);
    }

    console.log('\n5. ListAgents');
    console.log('  NOT RUN: ListAgents is a harness tool, not a shell command. Call it yourself before acting.');
}

// ── defer, gates and prime ──────────────────────────────────────────────────

/**
 * `defer <id> --until YYYY-MM-DD`: hide an open item from the board (status, footer, CURRENT.md, prime) until that date.
 * Appends a `defer` row; the item itself is untouched. The date must be in the future and the item open, and the
 * latest defer wins, so deferring again moves the date. Triage still lists it, marked deferred.
 */
function cmdDefer() {
    const id = positional[0];
    const until = arg('until');
    if (!id || !until) die('Usage: journal.ts defer <id> --until YYYY-MM-DD');
    if (!isDate(until)) die('--until must be YYYY-MM-DD.');
    if (until <= today()) die(`--until ${until} is not in the future (today is ${today()}).`);
    const entries = readLedger();
    const target = fold(entries).items.find((i) => i.id === id);
    if (!target) die(`No item with id "${id}".`);
    if (!isOpen(target)) die(`Item ${id} is not open (${target.state}); only an open item can be deferred.`);
    append({
        id: newId(entries), ts: now(), date: today(), kind: 'defer', defers: target.id, until,
        text: `deferred until ${until}`, ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`defer  ${target.id}  until ${until}  ${target.text}`);
}

/**
 * A deferral ends on a date but the generated pages are only written by ledger writes, so on the first read of a
 * new day, when any defer row exists, regenerate CURRENT.md and the stream pages. Derived files only; the ledger is untouched.
 */
function refreshBoard() {
    const current = join(dir, 'CURRENT.md');
    if (dryRun || !existsSync(current) || !readLedger().some((e) => e.kind === 'defer')) return;
    if (!readFileSync(current, 'utf8').includes(`updated: ${today()}`)) render(true);
}

/** This skill's checkout: the directory above scripts/. */
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The skill's own update line, then the auto_pull ask while that is unset; none at all when skipped for --no-update-check, update_check off and --dry-run. */
function updateNotices(): string[] {
    if (has('no-update-check') || dryRun || !UPDATE_CHECK) return [];
    const report = checkForUpdate({ repo: SKILL_DIR, autoPull: AUTO_PULL, autoPullSet: AUTO_PULL_SET });
    return [report.line, report.nudge].filter(Boolean);
}

function cmdPrime() {
    refreshBoard();
    primeLinesIn({ ...primeCtx(), notices: updateNotices() }).forEach((l) => console.log(l));
}

// ── pending tracker transitions ─────────────────────────────────────────────

function cmdTickets() {
    if (!has('pending')) die('Usage: journal.ts tickets --pending [--since YYYY-MM-DD] [--json]');
    const since = arg('since', defaultPendingSince());
    if (!isDate(since)) die('--since must be YYYY-MM-DD.');
    const rows = pendingTransitions(since);
    if (asJson) { console.log(JSON.stringify({ since, pending: rows }, null, 2)); return; }
    console.log(rows.length ? `Done items whose tracker transition is not recorded (since ${since}):` : `No pending tracker transitions since ${since}.`);
    rows.forEach((r) => console.log(`  ${r.key}  ${r.id}  done ${r.doneOn}  ${clip(r.text, 90)}`));
    if (rows.length) console.log('Move each ticket, then: journal.ts log "moved <KEY> to <status>" --transitioned <KEY> ...');
}

// ── dispatch ────────────────────────────────────────────────────────────────

switch (cmd) {
    case 'log': cmdLog('note'); break;
    case 'start': cmdLog('wip'); break;
    case 'ask': cmdLog('question', { ask: true }); break;
    case 'rule': cmdLog('decision', { rule: true }); break;
    case 'note': cmdLog('note'); break;
    case 'done': cmdClose('done'); break;
    case 'drop': cmdClose('dropped'); break;
    case 'resolve': cmdClose('resolved'); break;
    case 'stamp': cmdStamp(); break;
    case 'stamp-missing': cmdStampMissing(); break;
    case 'usage': cmdUsage(); break;
    case 'status': cmdStatus(); break;
    case 'standup': cmdStandup(); break;
    case 'roll': cmdRoll(); if (SCRIPTS_SHELF_DIR && !has('fast')) cmdScratch(); break;
    case 'scratch': cmdScratch(); break;
    case 'verify': cmdVerify(); break;
    case 'render': render(false, has('include-archived')); break;
    case 'tag': cmdTag(); break;
    case 'approve-tag': cmdApproveTag(); break;
    case 'approvals': cmdApprovals(); break;
    case 'streams': cmdStreams(); break;
    case 'models': cmdModels(); break;
    case 'fact': cmdFact(); break;
    case 'carry': cmdCarry(); break;
    case 'retro': cmdRetro(); break;
    case 'archive': cmdArchive(); break;
    case 'unarchive': cmdUnarchive(); break;
    case 'claim': cmdClaim(); break;
    case 'release': cmdRelease(); break;
    case 'claims': cmdClaims(); break;
    case 'backfill': cmdBackfill(); break;
    case 'triage': cmdTriage(); break;
    case 'defer': cmdDefer(); break;
    case 'prime': cmdPrime(); break;
    case 'tickets': cmdTickets(); break;
    case 'handoff': cmdHandoff(); break;
    case 'resume': cmdResume(); break;
    default:
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('/**')[1]
            .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
        process.exit(cmd ? 1 : 0);
}
