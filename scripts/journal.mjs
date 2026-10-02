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
 * --project is required. There is no default project name.
 *
 *   ledger.jsonl     append-only source of truth, one JSON object per line
 *   CURRENT.md       GENERATED view of what is open + done today
 *   YYYY-MM-DD.md    GENERATED daily archive, written by `roll`
 *   Streams/<S>.md   GENERATED one page per active stream (and a retro pointer for archived ones)
 *
 * The JSONL is the source of truth precisely so the markdown can be read and
 * edited freely without breaking anything. Regenerate with `render`.
 *
 *   journal.mjs log "<text>" --model "<name>" --used "skill:x,tool:y" [--kind note]
 *   journal.mjs start "<text>" --model "<name>" --used "skill:x,tool:y" [--repo x]
 *   journal.mjs done <id|text> --model "<name>" --used "skill:x,tool:y"
 *   journal.mjs drop <id> --model "<name>" --used "skill:x,tool:y" [--why "..."]
 *   journal.mjs ask "<question>" --model "<name>" --used "skill:x,tool:y"
 *   journal.mjs resolve <id> --model "<name>" --used "skill:x,tool:y" [--answer "..."]
 *   journal.mjs stamp <id> --model "<name>" --used "skill:x,tool:y"
 *   journal.mjs stamp-missing [--model unrecorded] [--used unrecorded] [--tokens unmeasured]
 *   journal.mjs usage [--open]                counts of model and used marks across items
 *   journal.mjs status [--full]               what is open + done today, with usage marks
 *   journal.mjs status --footer               the reply-footer Ledger lines, one per active stream, then the Session line
 *   journal.mjs standup [--date YYYY-MM-DD]   end-of-day summary for the team, no usage marks
 *   journal.mjs roll [--date YYYY-MM-DD]      archive finished work to a dated note (and, if configured, commit the ledger root)
 *   journal.mjs scratch                       with scripts_dir set: list <scripts_dir>/scratch with a promote/keep/delete-candidate proposal (`roll` prints it too; proposes only)
 *   journal.mjs verify [--json]               check every line parses, ids are unique, every reference exists; exit 1 on problems
 *   journal.mjs render                        rebuild CURRENT.md and Journal/Streams/<Stream>.md from the ledger
 *   journal.mjs tag <id> --stream <name>      file an existing item under a workstream
 *   journal.mjs log "<text>" --kind decision --approval standing|one-off [--scope "<what it covers>"] [--ref <memory-file-or-url>] --model ... --used ...
 *                                             an approval the user granted; `resolve` takes --approval too
 *   journal.mjs approvals [--since YYYY-MM-DD | --days 7] [--until YYYY-MM-DD] [--out <path>] [--force] [--json]   the approvals digest: standing (keep/narrow/revoke), one-off, untagged decisions
 *   journal.mjs approve-tag <id> --approval standing|one-off [--scope ..] [--ref ..]   mark an existing row as an approval (appends a row; nothing is rewritten)
 *   journal.mjs streams [list|add <name> [--alias a,b]|check]   the stream registry
 *   journal.mjs models [list|add <id> [--alias a,b]|check]   the model-name registry (a `models` section of streams.json)
 *   journal.mjs fact <key>=<value> --stream <name>   a structured metric; not an item, never open
 *   journal.mjs carry <id> --to <stream>      re-home an item (e.g. an open follow-up) to another stream
 *   journal.mjs retro <stream> [--out <path>] [--force]   draft the epic retro doc (status: draft)
 *   journal.mjs archive <stream>              hide a finished stream; refuses until retro + promotions are done
 *   journal.mjs unarchive <stream>            bring an archived stream back, exactly
 *   journal.mjs claim <repo> --desk <stream> [--branch b] [--why "..."] [--pid n]   take an exclusive repo lock (Claims/<repo>.lock)
 *   journal.mjs release <repo> --desk <stream> [--force]   drop it; only the holding desk may, unless --force
 *   journal.mjs claims [--stale-hours 12] [--json]         list claims with a stale check
 *   journal.mjs backfill [--dry-run] [--samples N] [--out <report.md>] [--json]   propose a stream for untagged items; writes nothing
 *   journal.mjs backfill --apply --min-confidence high|medium|low   append `tag` events for those proposals (one batch, one render)
 *   journal.mjs handoff --stream <name> [--out <path>] [--since YYYY-MM-DD] [--force]   scaffold the five-part handoff
 *   journal.mjs resume                        the verify-on-resume checklist, running the parts a script can run
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
 * Kinds: wip | done | blocked | question | decision | note | resolved | dropped | rolled | stamp
 *        (rows only written by their own commands: tag | fact | carry | archive | unarchive)
 * Common flags: --vault <path> --project <name> --json --dry-run --include-archived
 * retro/archive read tickets through ledger-index.mjs: --tickets-vault <path> (else $VAULT_ROOT),
 * --repo <name> picks Projects/<name>/Archive/ for the retro doc (default dev-env).
 * Root precedence: --vault, then $LEDGER_ROOT, then $VAULT_ROOT, each also settable in the
 * config file (see local-config.mjs).
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, renameSync, openSync, writeSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LEDGER_ROOT, VAULT_ROOT, LOOP_PATTERNS, RESUME_GH, LEDGER_GIT_AUTOCOMMIT, CLAUDE_PROJECTS_DIR, SCRIPTS_SHELF_DIR } from './local-config.mjs';
import { scratchReport } from './lib/scratch.mjs';
import { sessionLine } from './token-metrics.mjs';
import { isOpen, isNoStream, NON_ITEM_KINDS, mergeMark, readRegistry, canonicalOf, canonicalModel, mapModelWith, mapStreamWith, fold as foldWith } from './lib/ledger-core.mjs';

const DEFAULT_LEDGER_ROOT = LEDGER_ROOT || VAULT_ROOT;
const KINDS = ['wip', 'done', 'blocked', 'question', 'decision', 'note', 'resolved', 'dropped', 'rolled', 'stamp', 'tag', 'approval-tag'];

/** The values --approval accepts. Anything else is rejected at write time and flagged by `verify`. */
const APPROVALS = new Set(['standing', 'one-off']);

/** Row kinds that may carry --approval when written (`approve-tag` writes its own approval-tag row). */
const APPROVAL_WRITE_KINDS = new Set(['decision', 'resolved']);

/** Row kinds an approval can point at: the user's decision, their answer to an ask, or the ask itself. */
const APPROVABLE_KINDS = new Set(['decision', 'resolved', 'question']);

const argv = process.argv.slice(2);
const cmd = argv[0];

const BOOL_FLAGS = new Set(['--json', '--dry-run', '--full', '--open', '--allow-unmarked', '--new-stream', '--force', '--include-archived', '--footer', '--apply']);
function isFlagValue(a) {
    const i = argv.indexOf(a);
    return i > 0 && argv[i - 1].startsWith('--') && !BOOL_FLAGS.has(argv[i - 1]);
}
const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));
function arg(name, fallback = null) {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const dryRun = has('dry-run');
const asJson = has('json');
const vault = arg('vault', DEFAULT_LEDGER_ROOT);
if (!vault) {
    console.error('Ledger root is not set. Ask where the ledger lives, then set LEDGER_ROOT (or VAULT_ROOT), or pass --vault <path>.');
    process.exit(1);
}
const project = arg('project');
if (!project) {
    console.error('Pass --project <container-folder-name>. There is no default.');
    process.exit(1);
}
const dir = join(vault, 'Projects', project, 'Journal');
const ledgerPath = join(dir, 'ledger.jsonl');

const today = () => new Date().toISOString().slice(0, 10);
/**
 * A roll is recorded in the ledger with a timestamp, not inferred from the
 * archive file existing. Work finished AFTER a roll still shows in CURRENT.md,
 * so rolling at 5pm does not hide the evening's work.
 */
function rollPoint(entries, d) {
    const marks = entries.filter((e) => e.kind === 'rolled' && e.date === d);
    return marks.length ? marks[marks.length - 1].ts : null;
}
const now = () => new Date().toISOString();

function ensureDir() {
    if (!dryRun) mkdirSync(dir, { recursive: true });
}

function readLedger() {
    if (!existsSync(ledgerPath)) return [];
    return readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => {
            try { return JSON.parse(l); } catch { console.error(`  skipped malformed line ${i + 1}`); return null; }
        })
        .filter(Boolean);
}

function append(entry) {
    ensureDir();
    if (dryRun) { console.log('[dry-run]', JSON.stringify(entry)); return entry; }
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    return entry;
}

/** Append several rows in one write, so a batch is either all there or (on a crash) a prefix of whole lines. */
function appendMany(entries) {
    ensureDir();
    if (dryRun) { entries.forEach((e) => console.log('[dry-run]', JSON.stringify(e))); return entries; }
    if (entries.length) appendFileSync(ledgerPath, entries.map((e) => JSON.stringify(e) + '\n').join(''));
    return entries;
}

// ── stream registry ─────────────────────────────────────────────────────────

const registryPath = join(vault, 'Projects', project, 'streams.json');
let registryCache;

/** The stream registry (see readRegistry in lib/ledger-core.mjs), read once per run. */
function loadRegistry() {
    if (registryCache === undefined) registryCache = readRegistry(registryPath, () => console.error('  streams.json is malformed; ignoring the registry'));
    return registryCache;
}

function saveRegistry(reg) {
    mkdirSync(dirname(registryPath), { recursive: true });
    const tmp = `${registryPath}.tmp-${process.pid}`;
    const out = {};
    if (reg.hasStreams || Object.keys(reg.streams).length) out.streams = reg.streams;
    if (reg.models) out.models = reg.models;
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    renameSync(tmp, registryPath);
    registryCache = reg;
}

/** Read-time mapping through the loaded registry. */
const mapStream = (s) => mapStreamWith(loadRegistry(), s);

function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}

/** Nearest registered name or alias, as its canonical stream; null when nothing is close. */
function didYouMean(reg, name) {
    const k = name.trim().toLowerCase();
    let best = null;
    for (const [canon, meta] of Object.entries(reg.streams)) {
        for (const cand of [canon, ...(meta?.aliases || [])]) {
            const c = String(cand).toLowerCase();
            const dist = c.includes(k) || k.includes(c) ? 1 : editDistance(k, c);
            if (dist <= Math.max(2, Math.floor(k.length / 3)) && (!best || dist < best.dist)) best = { canon, dist };
        }
    }
    return best?.canon ?? null;
}

/**
 * Write-time normalisation for --stream. `none` stays reserved and passes through. With no
 * registry nothing is enforced. An unknown name is rejected with a suggestion unless --new-stream.
 */
function normaliseStream(raw) {
    if (!raw) return raw;
    if (isNoStream(raw)) return 'none';
    const reg = loadRegistry();
    if (!reg || !reg.hasStreams) return raw;
    const canon = canonicalOf(reg, raw);
    if (canon) {
        if (reg.streams[canon]?.status === 'archived') {
            console.error(`Stream "${canon}" is archived. Run \`journal.mjs unarchive ${canon}\` first.`);
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
    console.error(`Known: ${Object.keys(reg.streams).join(', ') || '(none)'}. Pass --new-stream to register it, or \`journal.mjs streams add <name>\`.`);
    process.exit(1);
}

/** Stream for a new row: `none` (reserved) and absent both mean no stream. */
function streamOrNone(raw) {
    const s = normaliseStream(raw);
    return s === 'none' ? undefined : s || undefined;
}

/** Short, collision-checked, human-typeable id. */
function newId(existing) {
    const taken = new Set(existing.map((e) => e.id));
    for (let n = 0; ; n++) {
        const id = Math.random().toString(36).slice(2, 6);
        if (!taken.has(id) && !/^\d+$/.test(id)) return id;
        if (n > 500) return `${Date.now()}`.slice(-6);
    }
}

const fold = (entries) => foldWith(entries, loadRegistry());

function resolveTarget(items, needle) {
    if (!needle) return null;
    const exact = items.find((i) => i.id === needle);
    if (exact) return exact;
    const open = items.filter(isOpen);
    const matches = open.filter((i) => i.text.toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
        console.error(`"${needle}" matches ${matches.length} open items:`);
        matches.forEach((m) => console.error(`  ${m.id}  ${m.text}`));
        process.exit(1);
    }
    return null;
}

function parseList(name) {
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
function normaliseModel(raw) {
    const reg = loadRegistry();
    if (!raw || MODEL_SENTINELS.has(raw) || !reg?.models || !Object.keys(reg.models).length) return raw;
    const canon = canonicalModel(reg, raw);
    if (!canon) {
        console.error(`unknown model "${raw}": not in the registry, written as-is. Register it with \`journal.mjs models add <id> --alias "${raw}"\`.`);
        return raw;
    }
    if (canon !== raw) console.error(`normalised model ${raw} -> ${canon}`);
    return canon;
}

function usageFromArgs() {
    const model = normaliseModel(arg('model'));
    const used = parseList('used');
    if (!has('allow-unmarked') && (!model || !used)) {
        console.error('Every ledger entry needs --model "<name>" and --used "skill:x,tool:y".');
        console.error('Do not guess. Unknown is --model unrecorded --used unrecorded. Tests may pass --allow-unmarked.');
        process.exit(1);
    }
    const usage = {};
    if (model) usage.model = model;
    if (used) usage.used = used;
    if (arg('tokens')) usage.tokens = arg('tokens');
    if (arg('harness')) usage.harness = arg('harness');
    if (arg('agent')) usage.agent = arg('agent');
    return usage;
}

function formatUsed(used) {
    if (!used) return null;
    return Array.isArray(used) ? used.join(', ') : String(used);
}

function usageSuffix(i) {
    const model = i.model || 'unrecorded';
    const used = formatUsed(i.used) || 'unrecorded';
    const bits = [`model: ${model}`, `used: ${used}`];
    if (i.closedBy?.model && i.closedBy.model !== i.model) {
        bits[0] = `model: ${model} → ${i.closedBy.model}`;
    }
    if (i.harness) bits.push(`harness: ${i.harness}`);
    if (i.tokens) bits.push(`tokens: ${i.tokens}`);
    return bits.join(' · ');
}

function fmt(i, { showId = true, showUsage = true } = {}) {
    const bits = [];
    if (showId) bits.push(`\`${i.id}\``);
    bits.push(i.text);
    const tail = [];
    if (i.repo) tail.push(i.repo);
    if (i.ticket) tail.push(`[[${i.ticket}]]`);
    if (showUsage) tail.push(usageSuffix(i));
    if (tail.length) bits.push(`— ${tail.join(' · ')}`);
    return bits.join(' ');
}

// ── commands ────────────────────────────────────────────────────────────────

const refsFromArgs = () => (arg('ref') || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * --approval standing|one-off, with its optional --scope. Returns the fields to merge into a row, or
 * nothing when the flag is absent. A value outside APPROVALS, or --scope without --approval, exits 1.
 */
function parseApproval() {
    const approval = arg('approval');
    if (has('approval') && !approval) die(`--approval needs a value: ${[...APPROVALS].join(' | ')}`);
    if (!approval) return has('scope') ? die('--scope only goes with --approval.') : {};
    if (!APPROVALS.has(approval)) die(`--approval must be one of: ${[...APPROVALS].join(', ')} (got "${approval}")`);
    return { approval, scope: arg('scope') || undefined };
}

/** parseApproval for a row of `kind`: --approval is only allowed on the kinds in APPROVAL_WRITE_KINDS. */
function approvalFor(kind) {
    const fields = parseApproval();
    if (fields.approval && !APPROVAL_WRITE_KINDS.has(kind)) die(`--approval only goes on: ${[...APPROVAL_WRITE_KINDS].join(', ')} (not ${kind}).`);
    return fields;
}

function cmdLog(kindDefault = 'note') {
    const text = arg('text') || positional.join(' ');
    if (!text) { console.error('Needs text: journal.mjs log "what happened"'); process.exit(1); }
    const kind = arg('kind', kindDefault);
    if (!KINDS.includes(kind)) { console.error(`kind must be one of: ${KINDS.join(', ')}`); process.exit(1); }

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
        refs: refsFromArgs(),
        ...approvalFor(kind),
        ...usageFromArgs(),
    };
    append(entry);
    if (!dryRun) render(true);
    console.log(`${entry.kind}  ${entry.id}  ${entry.text}`);
    return entry;
}

/** `resolve` may carry an approval (the user answered an `ask` with one); other closers reject the flag. */
const approvalClose = (kind) => {
    const fields = approvalFor(kind);
    return fields.approval ? { ...fields, refs: refsFromArgs() } : {};
};

function cmdClose(newKind) {
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
    if (!needle || !stream) { console.error('Usage: journal.mjs tag <id|text> --stream <name>'); process.exit(1); }
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
    if (!id || !fields.approval) die('Usage: journal.mjs approve-tag <id> --approval standing|one-off [--scope ..] [--ref ..]');
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 8601 week label (YYYY-Www) for a YYYY-MM-DD date. */
function isoWeek(d) {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));   // the Thursday of this week decides the year
    const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - yearStart) / DAY_MS + 1) / 7)).padStart(2, '0')}`;
}

/** A real calendar date: YYYY-MM-DD that reads back unchanged, so 2026-02-30 is rejected. */
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The digest window as { since, until }, both inclusive. `until` is --until, else today. `since` is
 * --since, else `--days N` (default 7) ending on `until`: exactly N calendar days, so weekly runs do not overlap.
 */
function approvalsWindow() {
    if (has('until') && !arg('until')) die('--until needs a value: YYYY-MM-DD.');
    const until = arg('until') ?? today();
    if (!isDate(until)) die('--until must be YYYY-MM-DD.');
    const since = arg('since');
    if (since) {
        if (!isDate(since)) die('--since must be YYYY-MM-DD.');
        if (since > until) die(`--since (${since}) is after --until (${until}).`);
        return { since, until };
    }
    const days = arg('days', '7');
    if (!/^[1-9]\d*$/.test(days)) die('--days must be a whole number of at least 1.');
    return { since: shiftDay(until, 1 - Number(days)), until };
}

/**
 * Approvals in the window, grouped, one entry per grant. A grant is a row that carries `approval`
 * itself, is pointed at by an `approval-tag` row, or closes a row with `--approval`; a closing row and
 * the row it closes are the same grant. The events of a grant merge field by field in ledger order: the
 * latest event that sets a field wins it, `scope` and `refs` carry over until replaced, and the entry
 * is reported under the latest event's row. A grant is in the window when any of its rows or tags is.
 * Untagged: `decision` rows that no approval touches.
 */
function collectApprovals(entries, { since, until }) {
    const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
    const grantOf = (row) => row.closes || row.id;
    const events = new Map();
    const add = (key, event) => events.set(key, [...(events.get(key) || []), event]);
    for (const e of entries) {
        if (!e.id || e.annotates) continue;
        if (e.kind === 'approval-tag') {
            const target = byId.get(e.approves);
            if (target) add(grantOf(target), { subject: target, fields: e, tag: e });
        } else if (e.approval) add(grantOf(e), { subject: e, fields: e });
    }
    const inWindow = (d) => String(d || '') >= since && String(d || '') <= until;
    const lastSet = (list, field) => list.map((ev) => ev.fields[field]).filter((v) => (Array.isArray(v) ? v.length : v)).pop();
    const out = { standing: [], oneOff: [], untagged: [] };
    const bucket = { standing: out.standing, 'one-off': out.oneOff };
    for (const list of events.values()) {
        const latest = list[list.length - 1].subject;
        if (!list.some((ev) => inWindow(ev.subject.date) || inWindow(ev.fields.date))) continue;
        bucket[lastSet(list, 'approval')]?.push({ id: latest.id, date: latest.date, text: latest.text, scope: lastSet(list, 'scope'), refs: lastSet(list, 'refs') || [], taggedBy: list.filter((ev) => ev.tag).pop()?.tag.id });
    }
    for (const e of entries) {
        if (e.id && !e.annotates && e.kind === 'decision' && !e.closes && !events.has(e.id) && inWindow(e.date)) out.untagged.push({ id: e.id, date: e.date, text: e.text, repo: e.repo });
    }
    for (const list of Object.values(out)) list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return out;
}

function approvalsText(g, { since, until }, week) {
    const refLine = (a) => (a.refs.length ? a.refs.join(', ') : 'none');
    return [
        '---', 'type: review', 'status: draft', `week: ${week}`, `generated: ${today()}`, `since: ${since}`, `until: ${until}`, '---', '',
        `# Approvals review ${week}`, '',
        `Generated by \`journal.mjs approvals\` for approvals dated ${since} to ${until}. Tick keep, narrow or revoke for each standing approval, then update wherever a narrowed or revoked one is recorded (memory files, config, instructions).`, '',
        '## Standing approvals', '',
        ...(g.standing.length ? g.standing.flatMap((a) => [
            `### ${a.date} \`${a.id}\``, '',
            clip(a.text, 400), '',
            `- Scope: ${a.scope || 'not recorded'}`, `- Ref: ${refLine(a)}`, `- Source row: \`${a.id}\`${a.taggedBy ? ` (tagged by \`${a.taggedBy}\`)` : ''}`,
            '- [ ] keep  - [ ] narrow  - [ ] revoke', '',
        ]) : ['_none_', '']),
        '## One-off approvals', '',
        'For awareness. No action needed.', '',
        ...(g.oneOff.length ? g.oneOff.map((a) => `- ${a.date} \`${a.id}\` ${clip(a.text, 200)} (ref: ${refLine(a)})`) : ['_none_']), '',
        '## Untagged decisions', '',
        'Decision rows with no approval tag. If any was the user granting permission, classify it with `journal.mjs approve-tag <id> --approval standing|one-off`.', '',
        ...(g.untagged.length ? g.untagged.map((a) => `- ${a.date} \`${a.id}\` ${clip(a.text, 200)}`) : ['_none_']), '',
    ].join('\n');
}

function cmdApprovals() {
    const window = approvalsWindow();
    const g = collectApprovals(readLedger(), window);
    const week = isoWeek(window.until);
    if (asJson) { console.log(JSON.stringify({ ...window, week, ...g }, null, 2)); return; }
    const body = approvalsText(g, window, week);
    if (dryRun) { console.log(body); return; }
    const path = arg('out') || join(ticketsBase(), 'Projects', project, 'Reviews', `approvals-${week}.md`);
    if (existsSync(path) && !has('force')) die(`${path} already exists. Pass --force to overwrite it.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`wrote ${path}  (${g.standing.length} standing, ${g.oneOff.length} one-off, ${g.untagged.length} untagged)`);
}

const streamTitle = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every stream that has at least one open or done-today item, in first-seen order. */
function activeStreams(...lists) {
    const seen = [];
    for (const list of lists) for (const i of list) if (i.stream && !seen.includes(i.stream)) seen.push(i.stream);
    return seen;
}
const inStream = (arr, s) => arr.filter((i) => i.stream === s);
const noStream = (arr) => arr.filter((i) => !i.stream);

function groups(includeArchived = false) {
    const entries = readLedger();
    const folded = fold(entries);
    const items = includeArchived ? folded.items : folded.items.filter((i) => !folded.hidden.has(i.id));
    const open = items.filter(isOpen);
    return {
        items,
        inflight: open.filter((i) => i.kind === 'wip'),
        blocked: open.filter((i) => i.kind === 'blocked'),
        awaiting: open.filter((i) => i.kind === 'question' || i.kind === 'decision'),
        decidedOn: (d) => items.filter((i) => i.closedBy?.kind === 'resolved' && i.closedBy.date === d),
        rollPointOn: (d) => rollPoint(entries, d),
        doneOn: (d, { sinceRoll = false } = {}) => {
            const cut = sinceRoll ? rollPoint(entries, d) : null;
            const after = (ts) => !cut || ts > cut;
            return items
                .filter((i) => i.closedBy?.kind === 'done' && i.closedBy.date === d && after(i.closedBy.ts))
                .concat(items.filter((i) => i.state === 'done' && i.date === d && !i.closedBy && after(i.ts)));
        },
        notesOn: (d) => items.filter((i) => i.state === 'note' && i.date === d),
        dates: [...new Set(items.map((i) => i.date))].sort(),
    };
}

/**
 * The reply-footer Ledger lines: one per active stream (canonical registry names), then `other` for
 * items with no stream. With no streams at all it is the single plain `Ledger` line.
 */
function footerLines(g, done) {
    const streams = activeStreams(g.inflight, g.blocked, g.awaiting, done);
    const fmtLine = (name, pick) => {
        const n = (arr) => arr.filter(pick).length;
        const blocked = n(g.blocked);
        return `**Ledger${name ? ` (${name})` : ''}:** ${n(done)} done today · ${n(g.inflight)} in flight · ${n(g.awaiting)} awaiting you${blocked ? ` · ${blocked} blocked` : ''}`;
    };
    if (!streams.length) return [fmtLine(null, () => true)];
    const lines = streams.map((s) => fmtLine(s, (i) => i.stream === s));
    const otherCount = [g.inflight, g.blocked, g.awaiting, done].reduce((a, arr) => a + noStream(arr).length, 0);
    if (otherCount) lines.push(fmtLine('other', (i) => !i.stream));
    return lines;
}

function cmdStatus() {
    const g = groups(has('include-archived'));
    const d = arg('date', today());
    const rolledAt = g.rollPointOn(d);
    const done = g.doneOn(d, { sinceRoll: true });

    if (asJson) {
        console.log(JSON.stringify({
            date: d,
            inflight: g.inflight, blocked: g.blocked, awaiting: g.awaiting, done,
        }, null, 2));
        return;
    }

    if (has('footer')) { [...footerLines(g, done), sessionLine(CLAUDE_PROJECTS_DIR)].forEach((l) => console.log(l)); return; }

    const line = (label, arr) => {
        if (!arr.length) return;
        console.log(`\n${label}`);
        arr.forEach((i) => console.log(`  ${fmt(i)}`));
    };
    console.log(`Ledger — ${d}`);
    for (const s of activeStreams(g.inflight, g.blocked, g.awaiting, done)) {
        console.log(`\n== ${streamTitle(s)} ==`);
        line('In flight', inStream(g.inflight, s));
        line('Blocked', inStream(g.blocked, s));
        line('Awaiting you', inStream(g.awaiting, s));
        line(`Done ${d}`, inStream(done, s));
    }
    line('In flight', noStream(g.inflight));
    line('Blocked', noStream(g.blocked));
    line('Awaiting you', noStream(g.awaiting));
    line(`Done ${d}`, noStream(done));
    if (rolledAt) console.log(`\n  (${g.doneOn(d).length - done.length} earlier item(s) archived to ${d}.md)`);
    if (has('full')) line('Notes', g.notesOn(d));
    if (!g.inflight.length && !g.blocked.length && !g.awaiting.length && !done.length) {
        console.log('\n  (empty)');
    }
    console.log(`\n  ${done.length} done · ${g.inflight.length} in flight · ${g.awaiting.length} awaiting you`);
}

function standupText(d) {
    const g = groups(has('include-archived'));
    const done = g.doneOn(d);
    const out = [`# Standup — ${d}`, ''];

    const section = (title, arr, empty) => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push(empty, ''); return; }
        arr.forEach((i) => {
            const note = i.closedBy && i.closedBy.text !== i.text ? ` — ${i.closedBy.text}` : '';
            out.push(`- ${fmt(i, { showId: false, showUsage: false })}${note}`);
        });
        out.push('');
    };

    for (const s of activeStreams(done, g.inflight, g.blocked, g.awaiting)) {
        out.push(`# ${streamTitle(s)}`, '');
        section('Shipped', inStream(done, s), '_Nothing closed._');
        section('In flight', inStream(g.inflight, s), '_Nothing running._');
        section('Blocked', inStream(g.blocked, s), '_Nothing blocked._');
        section('Awaiting you', inStream(g.awaiting, s), '_No open questions._');
        out.push('# Everything else', '');
    }
    section('Shipped', noStream(done), '_Nothing closed._');
    section('In flight', noStream(g.inflight), '_Nothing running._');
    section('Blocked', noStream(g.blocked), '_Nothing blocked._');
    section('Awaiting you', noStream(g.awaiting), '_No open questions._');

    const decided = g.decidedOn(d);
    if (decided.length) {
        out.push('## Decided', '');
        decided.forEach((i) => out.push(`- ${i.text} — ${i.closedBy.text}`));
        out.push('');
    }

    const notes = g.notesOn(d);
    if (notes.length) section('Notes', notes, '');
    return out.join('\n');
}

function cmdStandup() {
    console.log(standupText(arg('date', today())));
}

function render(quiet = false, includeArchived = false) {
    const g = groups(includeArchived);
    const d = today();
    const rolledDates = g.dates.filter((x) => g.rollPointOn(x));

    const out = [
        '---',
        'generated: true',
        `updated: ${d}`,
        '---',
        '',
        '# Current ledger',
        '',
        '> Generated from `ledger.jsonl` by `journal.mjs render`. Edits here are',
        '> overwritten — the JSONL is the source of truth. Dated archives are',
        '> written once and are yours to edit.',
        '',
    ];

    const section = (title, arr) => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push('_none_', ''); return; }
        arr.forEach((i) => out.push(`- ${fmt(i)}`));
        out.push('');
    };

    const doneToday = g.doneOn(d, { sinceRoll: true });
    for (const s of activeStreams(g.inflight, g.blocked, g.awaiting, doneToday)) {
        out.push(`# ${streamTitle(s)}`, '', `Stream page: [[${streamPageLink(s)}]]`, '');
        section('In flight', inStream(g.inflight, s));
        section('Blocked', inStream(g.blocked, s));
        section('Awaiting you', inStream(g.awaiting, s));
        section(`Done today (${d})`, inStream(doneToday, s));
        out.push('# Everything else', '');
    }
    section('In flight', noStream(g.inflight));
    section('Blocked', noStream(g.blocked));
    section('Awaiting you', noStream(g.awaiting));
    section(`Done today (${d})`, noStream(doneToday));
    if (g.rollPointOn(d)) out.push(`Earlier today archived -> [[${d}]]`, '');

    const retros = archivedRetros();
    if (retros.size) {
        out.push('## Archived streams', '');
        for (const s of retros.keys()) out.push(`- [[${streamPageLink(s)}]]`);
        out.push('');
    }

    if (rolledDates.length) {
        out.push('## Archive', '');
        rolledDates.slice().reverse().forEach((x) => out.push(`- [[${x}]]`));
        out.push('');
    }
    out.push('---', '', 'See CONTEXT.md in this project folder for durable project context.', '');

    if (dryRun) { if (!quiet) console.log(out.join('\n')); return; }
    ensureDir();
    writeFileSync(join(dir, 'CURRENT.md'), out.join('\n'));
    const pages = writeStreamPages(g, doneToday, retros, d);
    if (!quiet) console.log(`wrote ${join(dir, 'CURRENT.md')}${pages ? ` and ${pages} stream page(s) in ${join(dir, 'Streams')}` : ''}`);
}

const streamPageLink = (s) => `Streams/${slug(s)}`;

/** stream -> retro path (or '') for each stream whose latest event is an archive. */
function archivedRetros() {
    const out = new Map();
    for (const e of readLedger()) {
        if (e.kind === 'archive' && e.stream) out.set(mapStream(e.stream), e.retro || '');
        if (e.kind === 'unarchive' && e.stream) out.delete(mapStream(e.stream));
    }
    return out;
}

/**
 * One generated page per stream: every active stream (open or done today) and every stream the registry
 * lists as active, so a quiet stream reads "none" instead of going stale; archived streams get a page that
 * only points at the retro. Returns how many pages were written.
 */
function writeStreamPages(g, doneToday, retros, d) {
    const reg = loadRegistry();
    const registered = Object.entries(reg?.streams || {}).filter(([, m]) => m?.status !== 'archived').map(([k]) => k);
    const names = [...new Set([...activeStreams(g.inflight, g.blocked, g.awaiting, doneToday), ...registered])].filter((s) => !retros.has(s));
    if (!names.length && !retros.size) return 0;
    const streamsDir = join(dir, 'Streams');
    mkdirSync(streamsDir, { recursive: true });
    const head = (s, extra = []) => ['---', 'generated: true', `stream: ${s}`, `updated: ${d}`, '---', '', `# ${s}`, '',
        '> Generated from `ledger.jsonl` by `journal.mjs render`. Edits here are overwritten. The combined board is [[CURRENT]].', '', ...extra];
    for (const s of names) {
        const out = head(s);
        const section = (title, arr) => {
            out.push(`## ${title}`, '');
            if (!arr.length) { out.push('_none_', ''); return; }
            arr.forEach((i) => out.push(`- ${fmt(i)}`));
            out.push('');
        };
        section('In flight', inStream(g.inflight, s));
        section('Blocked', inStream(g.blocked, s));
        section('Awaiting you', inStream(g.awaiting, s));
        section(`Done today (${d})`, inStream(doneToday, s));
        writeFileSync(join(streamsDir, `${slug(s)}.md`), out.join('\n'));
    }
    for (const [s, retro] of retros) {
        const link = retro ? `Retro: [[${retro.split('/').pop().replace(/\.md$/, '')}]] (${retro})` : 'Retro: (path not recorded)';
        writeFileSync(join(streamsDir, `${slug(s)}.md`), head(s, ['This stream is **archived**. Its items are hidden from the board; `journal.mjs unarchive` brings them back.', '', link, '']).join('\n'));
    }
    return names.length + retros.size;
}

/** With scripts_dir set, print the scratch triage table. Read-only: it proposes, the user decides. */
function cmdScratch() {
    if (!SCRIPTS_SHELF_DIR) { console.log('scratch: scripts_dir is not set; nothing to list.'); return; }
    scratchReport(SCRIPTS_SHELF_DIR, readLedger().map((e) => e.text || '')).forEach((l) => console.log(l));
}

/**
 * Compression. Writes the day's finished work to a dated note and drops it out
 * of CURRENT.md, leaving a link. Open items are NOT archived — they stay
 * visible until they are actually closed.
 */
function cmdRoll() {
    const d = arg('date', today());
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
        model: 'n/a', used: ['tool:journal.mjs'], tokens: 'n/a',
    });
    render(true);
    console.log(`archived ${done.length} finished item(s) -> ${dest}`);
    console.log(`kept open: ${g.inflight.length} in flight, ${g.awaiting.length} awaiting you`);
    if (!autoCommitLedger(d)) process.exitCode = 1;
}

// ── verify and the ledger backup commit ─────────────────────────────────────

/** Integrity problems in the raw ledger file: unparseable lines, duplicate ids, references to ids that do not exist. */
function verifyLedger() {
    const problems = [];
    const text = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '';
    const rows = [];
    text.split('\n').forEach((l, n) => {
        if (!l.trim()) return;
        try {
            const row = JSON.parse(l);
            if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('not an object');
            rows.push({ row, line: n + 1 });
        } catch {
            problems.push({ line: n + 1, problem: 'line does not parse as a JSON object' });
        }
    });
    const seen = new Map();
    for (const { row, line } of rows) {
        if (row.id === undefined) continue;
        if (seen.has(row.id)) problems.push({ line, id: row.id, problem: `duplicate id (first on line ${seen.get(row.id)})` });
        else seen.set(row.id, line);
    }
    const missing = (line, row, field, id) => { if (id && !seen.has(id)) problems.push({ line, id: row.id, problem: `${field} refers to ${id}, which does not exist` }); };
    for (const { row, line } of rows) {
        if (row.approval !== undefined && !APPROVALS.has(row.approval)) problems.push({ line, id: row.id, problem: `approval "${row.approval}" is not one of: ${[...APPROVALS].join(', ')}` });
        if (row.kind === 'approval-tag' && !APPROVALS.has(row.approval)) problems.push({ line, id: row.id, problem: 'approval-tag row has no valid approval' });
        const target = row.kind === 'approval-tag' && row.approves ? rows.find((r) => r.row.id === row.approves)?.row : undefined;
        if (target && !APPROVABLE_KINDS.has(target.kind)) problems.push({ line, id: row.id, problem: `approves ${row.approves}, a ${target.kind} row; only ${[...APPROVABLE_KINDS].join(', ')} can be approved` });
        for (const field of ['closes', 'carries', 'tags', 'annotates', 'approves']) missing(line, row, field, row[field]);
        if (row.kind === 'archive') for (const id of row.ids || []) missing(line, row, 'archive ids', id);
    }
    problems.sort((a, b) => a.line - b.line);
    return { rows: rows.length, problems };
}

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

/**
 * The optional backup after a roll: only when ledger_git_autocommit is on and the ledger root is itself a
 * git repo. Runs verify first and refuses to commit a ledger that fails it. Stages explicit paths
 * (`git add -- <path>...`), never -A, and commits just those paths. Returns false when it should have
 * committed and could not.
 */
function autoCommitLedger(d) {
    if (!LEDGER_GIT_AUTOCOMMIT || dryRun) return true;
    const git = (...a) => spawnSync('git', ['-C', vault, ...a], { encoding: 'utf8' });
    const top = git('rev-parse', '--show-toplevel');
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(vault)) {
        console.error(`ledger_git_autocommit is on but ${vault} is not a git repository root; not committing.`);
        return true;
    }
    const { problems } = verifyLedger();
    if (problems.length) {
        console.error(`Not committing: verify found ${problems.length} problem(s). Run \`journal.mjs verify\`.`);
        return false;
    }
    const st = git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all');
    if (st.status !== 0) { console.error(`git status failed: ${st.stderr.trim()}`); return false; }
    const paths = st.stdout.split('\0').filter(Boolean).map((e) => e.slice(3));
    if (!paths.length) { console.log('ledger git: nothing to commit.'); return true; }
    const add = git('add', '--', ...paths);
    if (add.status !== 0) { console.error(`git add failed: ${add.stderr.trim()}`); return false; }
    const commit = git('commit', '-m', `chore(ledger): roll ${d}`, '--', ...paths);
    if (commit.status !== 0) { console.error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`); return false; }
    console.log(`ledger git: committed ${paths.length} path(s) as "chore(ledger): roll ${d}".`);
    return true;
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
    const marks = new Map();
    for (const e of entries) if (e.annotates) marks.set(e.annotates, mergeMark(marks.get(e.annotates), e));
    const fill = {
        model: normaliseModel(arg('model', 'unrecorded')),
        used: parseList('used') || ['unrecorded'],
        tokens: arg('tokens', 'unmeasured'),
    };
    const taken = [...entries];
    let count = 0;
    for (const e of entries) {
        if (!e.id || e.annotates || e.kind === 'stamp') continue;
        const cur = { ...e, ...(marks.get(e.id) || {}) };
        if (cur.model && cur.used) continue;
        const add = {};
        for (const f of ['model', 'used', 'tokens']) if (cur[f] === undefined) add[f] = fill[f];
        const row = { id: newId(taken), ts: now(), date: today(), kind: 'stamp', annotates: e.id, text: `stamp ${e.id}`, ...add };
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
    const models = new Map();
    const used = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const i of pool) {
        bump(models, i.model || 'unrecorded');
        (Array.isArray(i.used) ? i.used : [i.used || 'unrecorded']).forEach((x) => bump(used, x));
    }
    const sorted = (m) => [...m].sort((a, b) => b[1] - a[1]);
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

const die = (msg) => { console.error(msg); process.exit(1); };
const tally = (items) => ({
    open: items.filter(isOpen).length,
    done: items.filter((i) => i.state === 'done').length,
    dropped: items.filter((i) => i.state === 'dropped').length,
    total: items.length,
});

/** Canonical stream for a command argument; unknown to both registry and ledger is an error. */
function existingStream(name, items) {
    if (!name) die('Needs a stream name.');
    const stream = mapStream(name);
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
        const seen = [...new Set(items.map((i) => i.stream).filter(Boolean))];
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
        if (!name) die('Usage: journal.mjs streams add <name> [--alias a,b]');
        const aliases = parseList('alias') || [];
        const next = { ...(reg || {}), hasStreams: true, streams: { ...(reg?.streams || {}) } };
        const owner = canonicalOf(next, name);
        if (owner && owner !== name) die(`"${name}" is already registered as "${owner}" (name or alias, case-insensitive).`);
        const entry = next.streams[name] || { aliases: [], status: 'active' };
        for (const a of aliases) {
            const other = canonicalOf(next, a);
            if (other && other !== name) die(`Alias "${a}" already belongs to "${other}".`);
            if (a.toLowerCase() !== name.toLowerCase() && !entry.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) entry.aliases.push(a);
        }
        next.streams[name] = entry;
        const changed = JSON.stringify(reg?.streams?.[name]) !== JSON.stringify(entry);
        if (changed && !dryRun) saveRegistry(next);
        console.log(`${changed ? (reg?.streams[name] ? 'updated' : 'added') : 'unchanged'}  ${name}  aliases: ${entry.aliases.join(', ') || '(none)'}${dryRun && changed ? ' (dry-run)' : ''}`);
        return;
    }
    if (sub === 'check') {
        // Phase 2a dry run: how many rows would change display stream under the mapping. Appends nothing.
        const entries = readLedger();
        const raw = fold(entries).items;
        const rawStreams = new Map();
        for (const e of entries) {
            if (e.id && !e.closes && !e.annotates && !NON_ITEM_KINDS.includes(e.kind)) rawStreams.set(e.id, e.stream);
            if ((e.kind === 'tag' && e.tags) || (e.kind === 'carry' && e.carries)) rawStreams.set(e.tags || e.carries, e.stream || undefined);
        }
        const changes = new Map();
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
    die('Usage: journal.mjs streams [list|add <name> [--alias a,b]|check]');
}

/** A structured metric for a stream. Not an item: it never shows as open and never reaches the board. */
function cmdFact() {
    const pair = arg('text') || positional.join(' ');
    const eq = pair.indexOf('=');
    if (eq < 1) die('Usage: journal.mjs fact <key>=<value> --stream <name>');
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
    if (!needle || !to) die('Usage: journal.mjs carry <id|text> --to <stream>');
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
        if (!id) die('Usage: journal.mjs models add <canonical-id> [--alias a,b]');
        const next = { streams: {}, hasStreams: false, ...(reg || {}), models: { ...(reg?.models || {}) } };
        const owner = canonicalModel(next, id);
        if (owner && owner !== id) die(`"${id}" is already registered as "${owner}" (id or alias, case-insensitive).`);
        const entry = { aliases: [...(next.models[id]?.aliases || [])] };
        for (const a of parseList('alias') || []) {
            const other = canonicalModel(next, a);
            if (other && other !== id) die(`Alias "${a}" already belongs to "${other}".`);
            if (a.toLowerCase() !== id.toLowerCase() && !entry.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) entry.aliases.push(a);
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
    die('Usage: journal.mjs models [list|add <canonical-id> [--alias a,b]|check]');
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
const slug = (s) => s.trim().replace(/[\s/\\]+/g, '-');
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clip = (v, n = 140) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const PR_WORDS = /\bPRs?\b|pull request|release|#\d{2,}/i;
const LEARNING = /learned|lesson|ruled out|cause/i;
const TICKET_ID = /\b(?:[A-Za-z][A-Za-z0-9]*-)+\d{1,5}\b/g;
const itemText = (i) => [i.text, i.closedBy && i.closedBy.text !== i.text ? i.closedBy.text : ''].filter(Boolean).join(' — ');

/** Ticket status through ledger-index.mjs (the derived index); null when the index cannot be read. */
function ticketStatuses(ids) {
    const safe = ids.filter((id) => /^[\w.-]+$/.test(id));
    if (!safe.length) return new Map();
    const sql = `select id, status, title from tickets where id in (${safe.map((id) => `'${id}'`).join(',')})`;
    const r = spawnSync(process.execPath, [
        new URL('./ledger-index.mjs', import.meta.url).pathname, 'query', '--sql', sql, '--json',
        '--vault', vault, '--project', project, '--tickets-vault', ticketsBase(),
    ], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    try { return new Map(JSON.parse(r.stdout).map((t) => [t.id, t])); } catch { return null; }
}

function retroText(stream) {
    const entries = readLedger();
    const items = fold(entries).items.filter((i) => i.stream === stream);
    const facts = entries.filter((e) => e.kind === 'fact' && mapStream(e.stream) === stream);
    const carriedOut = entries.filter((e) => e.kind === 'carry' && e.from && mapStream(e.from) === stream && mapStream(e.stream) !== stream);
    const open = items.filter(isOpen);
    const done = items.filter((i) => i.state === 'done');
    const dropped = items.filter((i) => i.state === 'dropped');

    const touched = [
        ...items.flatMap((i) => [{ id: i.id, ts: i.ts, date: i.date, text: i.text, kind: i.kind }, ...(i.closedBy ? [{ id: i.closedBy.id, ts: i.closedBy.ts, date: i.closedBy.date, text: i.closedBy.text, kind: i.closedBy.kind }] : [])]),
        ...facts.map((f) => ({ id: f.id, ts: f.ts, date: f.date, text: f.text, kind: 'fact' })),
    ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const first = touched[0];
    const last = touched[touched.length - 1];
    const perDay = new Map();
    for (const t of touched) perDay.set(t.date, (perDay.get(t.date) || 0) + 1);

    const shipped = done.filter((i) => PR_WORDS.test(itemText(i)) || (i.refs || []).length);
    const refsOf = (i) => [...new Set([...(itemText(i).match(/#\d{2,}/g) || []), ...(i.refs || []).filter((r) => /^#\d+$/.test(r))])];
    const learnings = items.filter((i) => LEARNING.test(itemText(i)));

    const cited = new Map();
    for (const i of items) {
        if (i.ticket) cited.set(i.ticket, true);
        for (const id of itemText(i).match(TICKET_ID) || []) if (!cited.has(id)) cited.set(id, false);
    }
    const statuses = ticketStatuses([...cited.keys()]);

    const out = [
        '---', 'status: draft', `stream: ${stream}`, `generated: ${today()}`, 'type: retro', '---', '',
        `# ${stream} retro`, '',
        '> Draft generated by `journal.mjs retro`. Polish it, then change `status:` above to `reviewed` and fill every "Promoted to" line before `archive`.', '',
        '## Summary', '',
        `- Items done: ${done.length}`, `- Items dropped: ${dropped.length}`, `- Items open: ${open.length}`,
        `- Other rows (notes, resolved, decisions closed): ${items.length - done.length - dropped.length - open.length}`,
        `- Facts recorded: ${facts.length}`,
        `- Date span: ${first ? `${first.date} to ${last.date}` : '(no rows)'}`, '',
        '## Timeline', '',
        first ? `- First row: ${first.date} \`${first.id}\` ${clip(first.text, 100)}` : '- (no rows)',
        last ? `- Last row: ${last.date} \`${last.id}\` ${clip(last.text, 100)}` : '',
        '', '| Date | Rows |', '|---|---|',
        ...[...perDay].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => `| ${d} | ${n} |`), '',
        '## Facts', '',
        ...(facts.length ? ['| Key | Value | Date |', '|---|---|---|', ...facts.map((f) => `| ${cell(f.key)} | ${cell(f.value)} | ${f.date} |`)] : ['_none_']), '',
        '## Shipped', '',
        ...(shipped.length ? shipped.map((i) => `- \`${i.id}\` ${clip(itemText(i), 200)}${refsOf(i).length ? ` (${refsOf(i).join(', ')})` : ''}`) : ['_none_']), '',
        '## Tickets referenced', '',
        ...(cited.size ? [
            '| Ticket | Status | Title |', '|---|---|---|',
            ...[...cited].flatMap(([id, explicit]) => {
                const t = statuses?.get(id);
                if (t) return [`| ${cell(id)} | ${cell(t.status)} | ${cell(t.title)} |`];
                return explicit || !statuses ? [`| ${cell(id)} | ${statuses ? 'not in index' : 'index unavailable'} | |`] : [];
            }),
        ] : ['_none_']), '',
        '## Learnings', '',
        ...(learnings.length ? learnings.map((i) => `- \`${i.id}\` ${clip(itemText(i), 300)}`) : ['_none_']), '',
        '## Open follow-ups', '',
        ...(open.length ? open.map((i) => `- \`${i.id}\` [${i.kind}] ${clip(i.text, 200)}`) : ['_none_']),
        ...carriedOut.map((c) => `- carried to ${mapStream(c.stream)}: \`${c.carries}\``), '',
        '## Promoted to', '',
        'One line per learning. Give each a target (a DECISIONS.md entry, a skill, a ticket id) or `one-off`.', '',
        ...(learnings.length ? learnings.map((i) => `- [ ] ${clip(itemText(i), 120)} (\`${i.id}\`) — Promoted to: `) : ['_no learnings to promote_']), '',
    ];
    return out.join('\n');
}

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

function findRetro(stream) {
    const explicit = arg('retro');
    if (explicit) return existsSync(explicit) ? explicit : null;
    const dirPath = retroDir();
    if (!existsSync(dirPath)) return null;
    const hits = readdirSync(dirPath).filter((n) => n.startsWith(`${slug(stream)}-retro-`) && n.endsWith('.md')).sort();
    return hits.length ? join(dirPath, hits[hits.length - 1]) : null;
}

const retroStatus = (text) => (text.match(/^---\n([\s\S]*?)\n---/)?.[1].match(/^status:\s*["']?([^"'\s]+)/m) || [])[1] || 'draft';

/** Lines of the "Promoted to" checklist that still have no target. */
function unfilledPromotions(text) {
    const sec = text.split(/^## Promoted to\s*$/m)[1];
    if (!sec) return [];
    return sec.split(/^## /m)[0].split('\n').filter((l) => /^- \[[ xX]\] /.test(l))
        .filter((l) => !((l.match(/Promoted to:\s*(.*)$/) || [])[1] || '').trim());
}

function archiveBlockers(stream, items) {
    const blockers = [];
    const open = items.filter((i) => i.stream === stream && isOpen(i));
    for (const i of open) blockers.push(`open item ${i.id} [${i.kind}]: ${clip(i.text, 80)} (finish it, or \`carry ${i.id} --to <stream>\`)`);
    const retro = findRetro(stream);
    if (!retro) blockers.push(`no retro doc found in ${retroDir()} (run \`retro ${stream}\`)`);
    else {
        const text = readFileSync(retro, 'utf8');
        if (retroStatus(text) === 'draft') blockers.push(`retro ${retro} still has status: draft`);
        const blank = unfilledPromotions(text);
        if (blank.length) blockers.push(`${blank.length} "Promoted to" line(s) in ${retro} have no target or one-off`);
    }
    return { blockers, retro };
}

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

function setRegistryStatus(stream, status) {
    const reg = loadRegistry();
    if (!reg) { console.error(`  (no registry; ${stream} not marked ${status} there)`); return; }
    reg.streams[stream] = { aliases: [], ...(reg.streams[stream] || {}), status };
    saveRegistry(reg);
}

// ── repo claims ─────────────────────────────────────────────────────────────

const claimsDir = join(vault, 'Projects', project, 'Claims');
const claimPath = (repo) => join(claimsDir, `${repo}.lock`);
const validRepo = (r) => (r && /^[\w.-]+$/.test(r) && r !== '.' && r !== '..' ? r : die('Give a plain repo name (letters, digits, . _ -).'));

function readClaim(repo) {
    try { return JSON.parse(readFileSync(claimPath(repo), 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** { stale, reason } for a claim: its pid is dead on this host, or it is older than `hours`. A claim with no pid is judged on age alone. */
function claimStaleness(c, hours) {
    const age = c?.time ? (Date.now() - Date.parse(c.time)) / 36e5 : Infinity;
    if (c?.pid && c.host === hostname() && !pidAlive(c.pid)) return { stale: true, reason: `pid ${c.pid} is not running`, ageHours: age };
    if (age > hours) return { stale: true, reason: `older than ${hours}h`, ageHours: age };
    return { stale: false, reason: null, ageHours: age };
}

const describeClaim = (c) => (c ? `desk ${c.desk}, pid ${c.pid ?? 'unknown'}, host ${c.host}, since ${c.time}` : 'an unreadable claim');

/**
 * Exclusive create is the guarantee: openSync(path, 'wx') is O_CREAT|O_EXCL, so of any number of
 * racing processes exactly one succeeds. The `claim` ledger row is only the record.
 */
function cmdClaim() {
    const repo = validRepo(positional[0]);
    if (!arg('desk')) die('Usage: journal.mjs claim <repo> --desk <stream> [--branch b] [--why "..."] [--pid n]');
    const desk = normaliseStream(arg('desk'));
    const usage = usageFromArgs();
    const pid = arg('pid') ? Number(arg('pid')) : null;
    if (arg('pid') && !Number.isInteger(pid)) die('--pid must be an integer.');
    const claim = { repo, desk, pid, host: hostname(), time: now(), branch: arg('branch') || undefined, why: arg('why') || undefined };
    if (dryRun) { console.log('[dry-run]', JSON.stringify(claim)); return; }
    mkdirSync(claimsDir, { recursive: true });
    let fd;
    try {
        fd = openSync(claimPath(repo), 'wx');
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const held = readClaim(repo);
        console.error(`${repo} is already claimed by ${describeClaim(held)}.${held && claimStaleness(held, Number(arg('stale-hours', '12'))).stale ? ' It looks stale: `release --force` it if you are sure.' : ''}`);
        process.exit(1);
    }
    try { writeSync(fd, JSON.stringify(claim, null, 2) + '\n'); } finally { closeSync(fd); }
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

const CONF = ['low', 'medium', 'high'];
const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * Evidence about how already-tagged items are filed: stream counts per repo, per ticket id, and per
 * work session (a run of rows with no gap over 30 minutes; the ledger has no session field).
 */
function backfillEvidence(items) {
    const tagged = items.filter((i) => i.stream);
    const tally = (map, key, stream) => { if (!key) return; const m = map.get(key) || new Map(); m.set(stream, (m.get(stream) || 0) + 1); map.set(key, m); };
    const byRepo = new Map();
    const byTicket = new Map();
    for (const i of tagged) {
        tally(byRepo, i.repo, i.stream);
        for (const t of new Set([i.ticket, ...(itemText(i).match(TICKET_ID) || [])].filter(Boolean))) tally(byTicket, t, i.stream);
    }
    const sorted = [...items].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const sessionOf = new Map();
    let n = 0;
    let last = null;
    for (const i of sorted) {
        const t = Date.parse(i.ts);
        if (last !== null && t - last > SESSION_GAP_MS) n++;
        sessionOf.set(i.id, n);
        last = t;
    }
    const bySession = new Map();
    for (const i of tagged) tally(bySession, sessionOf.get(i.id), i.stream);
    return { byRepo, byTicket, bySession, sessionOf };
}

/** The top stream of a tally with its share and total, or null when empty or tied. */
function dominant(m) {
    if (!m) return null;
    const rows = [...m].sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((a, [, c]) => a + c, 0);
    if (rows.length > 1 && rows[0][1] === rows[1][1]) return null;
    return { stream: rows[0][0], n: rows[0][1], total, share: rows[0][1] / total };
}

/** Streams a backfill may propose: registered and not archived, plus every stream the ledger already uses. */
function candidateStreams(items, archived) {
    const reg = loadRegistry();
    const names = new Set([...Object.entries(reg?.streams || {}).filter(([, m]) => m?.status !== 'archived').map(([k]) => k), ...items.map((i) => i.stream).filter(Boolean)]);
    for (const a of archived) names.delete(a);
    return names;
}

/** Votes for one untagged item: [{ rule, stream, points }]. Points: ticket 4 (unanimous, 2+ items) or 1, keyword 2, repo 2 (90%+ of 5+ items) or 1, session neighbours 1. 4+ is high, 2-3 medium, 1 low. */
function votesFor(item, ev, keywords) {
    const votes = [];
    const tickets = new Set([item.ticket, ...(itemText(item).match(TICKET_ID) || [])].filter(Boolean));
    let best = null;
    for (const t of tickets) {
        const d = dominant(ev.byTicket.get(t));
        if (!d) continue;
        const points = d.share === 1 && d.n >= 2 ? 4 : 1;
        if (!best || points > best.points) best = { rule: 'ticket', stream: d.stream, points };
    }
    if (best) votes.push(best);

    const text = itemText(item).toLowerCase();
    const hits = new Set(keywords.filter((k) => k.re.test(text)).map((k) => k.stream));
    if (hits.size === 1) votes.push({ rule: 'keyword', stream: [...hits][0], points: 2 });

    const r = dominant(ev.byRepo.get(item.repo));
    if (r) votes.push({ rule: 'repo', stream: r.stream, points: r.share >= 0.9 && r.total >= 5 ? 2 : 1 });

    const s = dominant(ev.bySession.get(ev.sessionOf.get(item.id)));
    if (s && s.total >= 2 && s.share >= 0.6) votes.push({ rule: 'session', stream: s.stream, points: 1 });
    return votes;
}

/** { stream, confidence, rules } for an untagged item, or null when nothing votes. Disagreement caps it at low. */
function proposalFor(item, ev, keywords, allowed) {
    const votes = votesFor(item, ev, keywords).filter((v) => allowed.has(v.stream));
    if (!votes.length) return null;
    const score = new Map();
    for (const v of votes) score.set(v.stream, (score.get(v.stream) || 0) + v.points);
    const ranked = [...score].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return { stream: null, confidence: 'low', rules: votes.map((v) => v.rule), tie: true };
    const [stream, points] = ranked[0];
    const conflict = ranked.length > 1;
    const confidence = conflict ? 'low' : points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low';
    return { stream, confidence, rules: votes.filter((v) => v.stream === stream).map((v) => v.rule), conflict };
}

function backfillProposals() {
    const folded = fold(readLedger());
    const untagged = folded.items.filter((i) => !i.stream && !folded.hidden.has(i.id));
    const ev = backfillEvidence(folded.items);
    const allowed = candidateStreams(folded.items, folded.archivedStreams);
    const reg = loadRegistry();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keywords = Object.entries(reg?.streams || {}).filter(([canon]) => allowed.has(canon)).flatMap(([canon, meta]) =>
        [canon, ...(meta?.aliases || [])].map(String).filter((w) => w.length >= 3)
            .map((w) => ({ stream: canon, re: new RegExp(`(?<![\\w-])${esc(w.toLowerCase())}(?![\\w-])`) })));
    const proposals = untagged.map((item) => ({ item, ...(proposalFor(item, ev, keywords, allowed) || { stream: null, confidence: null, rules: [] }) }));
    return { proposals, untagged: untagged.length };
}

function cmdBackfill() {
    const minConf = arg('min-confidence', 'high');
    if (!CONF.includes(minConf)) die(`--min-confidence must be one of: ${CONF.join(', ')}`);
    const { proposals, untagged } = backfillProposals();
    const proposed = proposals.filter((p) => p.stream);
    const apply = has('apply');
    const selected = proposed.filter((p) => CONF.indexOf(p.confidence) >= CONF.indexOf(minConf));

    if (apply) {
        const entries = readLedger();
        const runId = `bf-${newId(entries)}`;
        const taken = [...entries];
        const rows = selected.map((p) => {
            const row = {
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

    const groups = new Map();
    for (const p of proposed) {
        const g = groups.get(p.stream) || { high: [], medium: [], low: [] };
        g[p.confidence].push(p);
        groups.set(p.stream, g);
    }
    const perStream = [...groups].map(([stream, g]) => ({ stream, high: g.high.length, medium: g.medium.length, low: g.low.length, total: g.high.length + g.medium.length + g.low.length }))
        .sort((a, b) => b.total - a.total);
    const perConf = Object.fromEntries(CONF.slice().reverse().map((c) => [c, proposed.filter((p) => p.confidence === c).length]));
    const noProposal = proposals.length - proposed.length;
    const nSamples = Number(arg('samples', '3'));
    const sample = (p) => `${p.item.id}  ${clip(p.item.text, 90)}  [${p.rules.join('+')}${p.item.repo ? `; repo ${p.item.repo}` : ''}]`;

    if (arg('out')) {
        const table = ['| id | date | kind | repo | ticket | proposed | confidence | rules |', '|---|---|---|---|---|---|---|---|',
            ...proposals.map((p) => `| ${p.item.id} | ${p.item.date} | ${p.item.kind} | ${cell(p.item.repo)} | ${cell(p.item.ticket)} | ${p.stream || ''} | ${p.confidence || ''} | ${p.rules.join('+')} |`)];
        writeFileSync(arg('out'), ['---', 'type: backfill-report', `generated: ${today()}`, '---', '', '# Backfill dry run', '', ...table, ''].join('\n'));
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
            const list = groups.get(s.stream)[c];
            if (!list.length) continue;
            console.log(`  ${s.stream} / ${c}`);
            list.slice(0, nSamples).forEach((p) => console.log(`    ${sample(p)}`));
        }
    }
    console.log(`\nApply with: backfill --apply --min-confidence high (${selected.length} row(s) at high) after review.`);
}

// ── handoff and resume ──────────────────────────────────────────────────────

const PATH_LIKE = /(?:^|[\s(`'"])((?:~\/|\.{1,2}\/|\/)[\w.@~+-]+(?:\/[\w.@~+-]+)*(?::\d+)?|[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,6}(?::\d+)?)(?=[\s),.;:`'"]|$)/g;
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

/** PR numbers, refs, tickets and file paths mentioned by a set of items, each listed once. */
function artifactsOf(items) {
    const found = new Map();
    const add = (kind, v) => found.set(`${kind} ${v}`, { kind, v });
    for (const i of items) {
        const text = itemText(i);
        for (const r of i.refs || []) add(/^#\d+$/.test(r) ? 'pr' : 'ref', r);
        for (const n of text.match(/#\d{2,}/g) || []) add('pr', n);
        if (i.ticket) add('ticket', i.ticket);
        for (const t of text.match(TICKET_ID) || []) add('ticket', t);
        for (const m of text.matchAll(PATH_LIKE)) add('path', m[1]);
    }
    return [...found.values()];
}

function handoffText(stream, since) {
    const items = fold(readLedger()).items.filter((i) => i.stream === stream);
    const d = today();
    const recent = (i) => (i.closedBy?.date || i.date) >= since || i.date >= since;
    const open = items.filter((i) => isOpen(i) && (i.kind === 'wip' || i.kind === 'blocked'));
    const doneRecently = items.filter((i) => i.state === 'done' && (i.closedBy?.date || i.date) >= since);
    const awaiting = items.filter((i) => isOpen(i) && (i.kind === 'question' || i.kind === 'decision'));
    const learnings = items.filter((i) => recent(i) && LEARNING.test(itemText(i)));
    const touched = items.filter((i) => isOpen(i) || recent(i));
    const arts = artifactsOf(touched);
    const meta = (i) => [i.repo, i.ticket && `[[${i.ticket}]]`].filter(Boolean).join(' · ');
    const line = (i, tag) => `- \`${i.id}\` [${tag}] ${clip(itemText(i), 200)}${meta(i) ? ` — ${meta(i)}` : ''}`;
    const one = (kind) => arts.filter((a) => a.kind === kind).map((a) => a.v);

    return [
        '---', 'status: draft', `stream: ${stream}`, `generated: ${d}`, `since: ${since}`, 'type: handoff', '---', '',
        `# ${stream} handoff, ${d}`, '',
        '> Scaffolded by `journal.mjs handoff` from the ledger. Sections 1, 3 and 4 are derived; 2 and 5 need the author. A fresh session runs `journal.mjs resume`, and calls `ListAgents` itself.', '',
        '## 1. Tasks with status', '',
        ...(open.length || doneRecently.length ? [
            ...open.map((i) => line(i, i.kind === 'blocked' ? 'blocked' : 'in flight')),
            ...doneRecently.map((i) => line(i, `done ${i.closedBy?.date || i.date}`)),
        ] : ['_none_']), '',
        '## 2. Learnings, including what was ruled out', '',
        ...(learnings.length ? learnings.map((i) => line(i, i.kind)) : ['_None matched learned, lesson, ruled out or cause. Write what was ruled out here._']), '',
        '## 3. Artifacts', '',
        ...(arts.length ? [
            ...(one('pr').length ? [`- PRs: ${one('pr').join(', ')}`] : []),
            ...(one('ticket').length ? [`- Tickets: ${one('ticket').join(', ')}`] : []),
            ...(one('ref').length ? [`- Refs: ${one('ref').join(', ')}`] : []),
            ...(one('path').length ? [`- Paths: ${one('path').join(', ')}`] : []),
        ] : ['_none_']), '',
        '## 4. Decisions awaiting', '',
        ...(awaiting.length ? awaiting.map((i) => line(i, i.kind)) : ['_none_']), '',
        '## 5. Next concrete action', '',
        '_Author: one concrete first step for the fresh session._', '',
        '## Cleanup candidates', '',
        '_Run `node scripts/branch-sweep.mjs` and paste its table here; nothing is deleted without approval._', '',
        'Then run `journal.mjs resume` and verify: ledger status, open PRs, running loops, and `ListAgents`.', '',
    ].join('\n');
}

function cmdHandoff() {
    const { items } = fold(readLedger());
    const stream = existingStream(arg('stream'), items);
    const since = arg('since', yesterday());
    const path = arg('out') || join(dir, `HANDOFF-${today()}-${slug(stream)}.md`);
    if (existsSync(path) && !has('force')) die(`${path} already exists. Pass --force to overwrite it, or --out <path>.`);
    const body = handoffText(stream, since);
    if (dryRun) { console.log(body); return; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`wrote ${path}`);
}

/** Runs a command; { ok, out } where ok is false when it is missing or exits non-zero. */
function tryRun(cmdName, args) {
    const r = spawnSync(cmdName, args, { encoding: 'utf8' });
    return { ok: !r.error && r.status === 0, missing: Boolean(r.error), out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

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
            let prs = [];
            try { prs = JSON.parse(r.out || '[]'); } catch { /* fall through to the count */ }
            console.log(`  ${prs.length} open`);
            prs.forEach((p) => console.log(`  #${p.number} ${p.title} ${p.url}`));
        }
    }

    console.log('\n3. Loops (pgrep)');
    if (!LOOP_PATTERNS.length) console.log('  none configured (set loop_patterns in the config)');
    for (const pattern of LOOP_PATTERNS) {
        const r = tryRun('pgrep', ['-f', pattern]);
        if (r.missing) console.log(`  ${pattern}: pgrep unavailable`);
        else console.log(r.ok ? `  ok       ${pattern} (pid ${r.out.split('\n').join(', ')})` : `  MISSING  ${pattern}`);
    }

    console.log('\n4. ListAgents');
    console.log('  NOT RUN: ListAgents is a harness tool, not a shell command. Call it yourself before acting.');
}

// ── dispatch ────────────────────────────────────────────────────────────────

switch (cmd) {
    case 'log': cmdLog('note'); break;
    case 'start': cmdLog('wip'); break;
    case 'ask': cmdLog('question'); break;
    case 'note': cmdLog('note'); break;
    case 'done': cmdClose('done'); break;
    case 'drop': cmdClose('dropped'); break;
    case 'resolve': cmdClose('resolved'); break;
    case 'stamp': cmdStamp(); break;
    case 'stamp-missing': cmdStampMissing(); break;
    case 'usage': cmdUsage(); break;
    case 'status': cmdStatus(); break;
    case 'standup': cmdStandup(); break;
    case 'roll': cmdRoll(); if (SCRIPTS_SHELF_DIR) cmdScratch(); break;
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
    case 'handoff': cmdHandoff(); break;
    case 'resume': cmdResume(); break;
    default:
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('/**')[1]
            .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
        process.exit(cmd ? 1 : 0);
}
