/** Help for journal.ts: one table of commands (name, arguments, summary, flags) that both `--help` forms are printed from. Pure: it reads only what it is given. */
import { ASK_USAGE, CLASSES, DOORS } from './ask-fields.ts';
import { CONFIDENCES, LEARNED_KINDS, LEARNED_USAGE } from './learned.ts';
import { MISS_SOURCES } from './miss.ts';
import { QUERY_STATUSES } from './query.ts';

type Flag = [flag: string, meaning: string];

export interface CommandHelp {
    name: string;
    /** Positional words after the command, as typed: `<id>`, `"<text>"`. Empty when there are none. */
    args: string;
    summary: string;
    flags: Flag[];
    /** True for a command that needs no project, so the global `--project` line is not printed under it. */
    noProject?: boolean;
    /** Extra usage lines printed after the flags, for commands that already carried their own. */
    notes?: readonly string[];
}

const MARK: Flag[] = [['--model "<name>"', 'the model that did the work (folded through the model registry)'], ['--used "skill:x,tool:y"', 'skills and tools the work used']];
const JSON_OUT: Flag = ['--json', 'machine-readable output'];
const STATUS_DIR: Flag = ['--status-dir <dir>', 'the status directory (default: MAESTRO_STATUS_DIR or the configured one)'];
const oneOf = (values: readonly string[]): string => values.join('|');
const CONTAINER: Flag = ['--container <dir>', 'the directory the sweep runs from (default: the current one); it must be inside container_root, and the swept root is always container_root'];
const DATE: Flag = ['--date YYYY-MM-DD', 'the day to use (default: today)'];

/** Flags every command takes, printed once under each command's own (with --project for commands that need one). */
export const GLOBAL_FLAGS: Flag[] = [
    ['--text "<text>"', 'the text of a row, instead of the positional words'],
    ['--vault <root>', 'ledger root (default: LEDGER_ROOT, else VAULT_ROOT)'],
    ['--dry-run', 'where a command supports it, report instead of writing'],
    ['--help, -h', 'print this usage and exit without running anything'],
];

const LOG_FLAGS: Flag[] = [
        DATE, ['--kind wip|done|blocked|question|decision|note|rework', 'row kind (default note)'], ['--stream <name>', 'file under a workstream'], ['--repo <name>', 'repo the row is about'], ['--ticket <id>', 'ticket the row is about'],
        ['--gate gh:pr:<repo>#N|date:YYYY-MM-DD|ticket:<id>', 'with --kind blocked: what the item waits for'], ['--approval standing|one-off', 'with --kind decision: an approval the user granted'],
        ['--scope "<what it covers>"', 'with --approval'], ['--scope window|global', 'on a decision or note without --approval: window binds only this window, global binds all (no flag reads as global)'], ['--ref <file-or-url>', 'memory file or URL behind an approval, repeatable'], ['--transitioned KEY[,KEY]', 'tracker tickets that were moved'], ...MARK];

/** The `--project` line, printed under every command that is not marked `noProject`. */
const PROJECT_FLAG: Flag = ['--project <name>', 'required unless the `project` setting or MAESTRO_PROJECT names one'];

export const COMMANDS: CommandHelp[] = [
    { name: 'log', args: '"<text>"', summary: 'Append a row (a note by default); also records blocked gates, approvals, rework and tracker transitions.', flags: LOG_FLAGS },
    { name: 'note', args: '"<text>"', summary: 'Same as log: append a note row.', flags: LOG_FLAGS },
    { name: 'start', args: '"<text>" | <id>', summary: 'Open an in-flight item, or promote a queued one by id.', flags: [
        ['--repo <name>', 'repo'], ['--ticket <id>', 'ticket'], ['--stream <name>', 'workstream'], ['--worktree <w>', 'where the work lives'], ['--branch <b>', 'branch the work is on'], ['--next "<step>"', 'what happens next'], ...MARK] },
    { name: 'queue', args: '"<text>" | <id>', summary: 'Open a queued to-do, or move an in-flight item back to queued.', flags: [['--stream <name>', 'workstream'], ['--repo <name>', 'repo'], ['--ticket <id>', 'ticket'], ...MARK] },
    { name: 'ask', args: '"<question>"', summary: 'Put a question or a run-this block on the awaiting-you board.', flags: [
        ['--kind question|decision', 'a decision still pending'], ['--stream <name>', 'workstream'], ['--repo <name>', 'repo the ask is about'], ['--ticket <id>', 'ticket'], ['--searched "<where I looked>"', 'required: what you checked before asking; refused without it'], ['--outward', 'anything another person sees: always asks, never acted on a default'], ['--how-do-i', 'the question is a how-do-I the library could not answer: also logged as a miss'], ['--recommend "<text>"', 'what you would do'], [`--door ${oneOf(DOORS)}`, 'reversibility'],
        ['--default "<text>"', 'what happens if silent (two-way only)'], ['--decide-by <date|2d|6h|1w>', 'deadline (alias --by)'], [`--class ${oneOf(CLASSES)}`, 'urgency class'], ['--paste <file>', 'a run-this ask: the block file'], ...MARK], notes: ASK_USAGE },
    { name: 'rule', args: '"<text>"', summary: 'Record a decision already made; refuses unless every --ref is an existing file.', flags: [['--ref <file>', 'required: an existing supporting file; repeat it, or comma-separate, for several'], ['--scope window|global', 'window: binds only the window that wrote it (an instruction given in one window); global binds all'], ...MARK] },
    { name: 'decide', args: '"<decision>"', summary: 'Write a decision down the turn it is said.', flags: [
        ['--why "<rationale>"', 'required'], ['--rejected "<alt>"', 'alternative turned down'], ['--consequence "<text>"', 'what follows from it'], ['--scope project|working-rule', 'where it is written (default project)'],
        ['--binds window|global', 'window: a rule for this window only, recorded as a ledger row with no file (an instruction such as "pause X here today"); global: written as usual and marked global'], ['--topic <slug>', 'topic of a working rule'], ['--repo <project>', 'project whose DECISIONS.md gets it'], ['--msg "[msg <ts> <6 hex>]"', 'the one decision-scan marker, exactly as printed, so that message is not raised again'], ['--new', 'always write a new entry'], ...MARK] },
    { name: 'learned', args: '"<claim>"', summary: 'Record one fact someone established, with evidence.', flags: [
        [`--kind ${oneOf(LEARNED_KINDS)}`, 'required'], ['--applies-to <repo:component[:env]>', 'required'], ['--evidence "<text>"', 'required'], ['--verified-at "<sha | date how>"', 'required'],
        [`--confidence ${oneOf(CONFIDENCES)}`, 'required'], ['--supersedes <id|path>', 'an earlier learned id or page path'], ...MARK], notes: LEARNED_USAGE },
    { name: 'miss', args: '"<question>"', summary: 'Record a question the library could not answer, for the composer.', flags: [[`--source ${oneOf(MISS_SOURCES)}`, 'where the question came from (required)'], ['--repo <name>', 'repo'], ...MARK] },
    { name: 'misses', args: '', summary: 'List the open misses grouped by topic.', flags: [JSON_OUT] },
    { name: 'find', args: '"<words>"', summary: 'Look up library pages, best first.', flags: [
        ['--repo <name>', 'filter by repo'], ['--kind <kind>', 'filter by kind'], ['--component <name>', 'filter by component'], ['--limit <n>', 'result cap (default 10)'], ['--neighbors', 'add pages one link away'],
        ['--include-superseded', 'include superseded pages'], ['--no-miss', 'do not log a miss when nothing matches'], ['--tickets-vault <path>', 'library root (default VAULT_ROOT)'], JSON_OUT] },
    { name: 'done', args: '<id|text>', summary: 'Close an item (an id or a unique substring).', flags: [['--why "<text>"', 'a note recorded with the close'], ['--answer "<text>"', 'a note recorded with the close (wins over --why)'], ['--ticket <id>', 'ticket to attach'], ...MARK] },
    { name: 'drop', args: '<id>', summary: 'Drop an item.', flags: [['--why "<text>"', 'why it was dropped'], ['--ticket <id>', 'ticket to attach'], ...MARK] },
    { name: 'resolve', args: '<id>', summary: 'Answer an ask.', flags: [['--answer "<text>"', 'the answer'], ['--ticket <id>', 'ticket to attach'], ['--approval standing|one-off', 'record the answer as an approval'], ['--scope "<text>"', 'with --approval: what it covers'], ['--ref <file-or-url>', 'with --approval: supporting reference, repeatable'], ...MARK] },
    { name: 'answer', args: '<ask id>', summary: 'Record the user\'s answer to an ask.', flags: [['--text "<answer>"', 'the answer (required)'], ['--source page|chat', 'where it came from'], ...MARK] },
    { name: 'discuss', args: '<ask id>', summary: 'Mark an ask as under discussion.', flags: [['--text "<topic>"', 'what is being discussed'], ...MARK] },
    { name: 'stamp', args: '<id>', summary: 'Add model and used marks to an existing item.', flags: [...MARK] },
    { name: 'stamp-missing', args: '', summary: 'Stamp every item that has no marks.', flags: [['--model <name>', 'default unrecorded'], ['--used <marks>', 'default unrecorded'], ['--tokens <value>', 'default unmeasured']] },
    { name: 'usage', args: '', summary: 'Count model and used marks across items.', flags: [['--open', 'open items only']] },
    { name: 'status', args: '', summary: 'What is open and done today; --footer forms print the reply footer.', flags: [
        ['--full', 'every section in full'], ['--footer', 'the reply-footer lines'], ['--line', 'with --footer: one line for a status line'], ['--session <id>', 'measure that transcript instead of the newest'],
        ['--stdin', 'read the session id from a status-line command\'s JSON on stdin'], ['--include-archived', 'show archived streams'], JSON_OUT] },
    { name: 'review-queue', args: '', summary: 'The push gate: open non-draft PRs against the review cap. Exit 0 room, 1 full, 2 cannot answer.', flags: [['--cap <n>', 'cap (default review_queue_cap, 4)'], JSON_OUT] },
    { name: 'standup', args: '', summary: 'End-of-day summary for the team, no usage marks.', flags: [DATE, ['--include-archived', 'show archived streams']] },
    { name: 'maintain', args: '', summary: 'The model-free half of roll for an unattended caller; ends with one JSON line.', flags: [['--today YYYY-MM-DD', 'required: the day to archive up to'], CONTAINER, ['--budget <n>', 'work budget']] },
    { name: 'roll', args: '', summary: 'Triage, archive finished work to a dated note, commit the ledger root, sweep stale worktrees. Writes.', flags: [
        DATE, ['--strict', 'refuse (exit 1) before changing anything when triage has blockers'], CONTAINER, ['--no-worktree-sweep', 'skip the worktree sweep'], ['--fast', 'skip the sweep and the scratch review']] },
    { name: 'scratch', args: '', summary: 'List the scripts shelf scratch folder with a keep/promote/delete proposal (proposes only).', flags: [] },
    { name: 'verify', args: '', summary: 'Check every ledger line parses, ids are unique and references exist; exit 1 on problems.', flags: [JSON_OUT] },
    { name: 'render', args: '', summary: 'Rebuild CURRENT.md and the stream pages from the ledger.', flags: [['--include-archived', 'include archived streams']] },
    { name: 'tag', args: '<id>', summary: 'File an existing item under a workstream.', flags: [['--stream <name>', 'the workstream (required)'], ['--new-stream', 'allow a name not in the registry']] },
    { name: 'approve-tag', args: '<id>', summary: 'Mark an existing row as an approval.', flags: [['--approval standing|one-off', 'required'], ['--scope "<text>"', 'what it covers'], ['--ref <file-or-url>', 'supporting reference']] },
    { name: 'ref', args: '<id>', summary: 'Attach existing ref files to a decision.', flags: [['--ref <file>', 'a file that exists, repeatable']] },
    { name: 'approvals', args: '', summary: 'The approvals digest: standing, one-off and untagged decisions.', flags: [['--since YYYY-MM-DD', 'window start'], ['--days <n>', 'window length (default 7)'], ['--until YYYY-MM-DD', 'window end'], ['--out <path>', 'write the digest here'], ['--force', 'overwrite --out'], JSON_OUT] },
    { name: 'streams', args: '[list|add <name>|check]', summary: 'The stream registry.', flags: [['--alias a,b', 'with add: aliases for the stream']] },
    { name: 'models', args: '[list|add <id>|check]', summary: 'The model-name registry.', flags: [['--alias a,b', 'with add: aliases for the model']] },
    { name: 'fact', args: '<key>=<value>', summary: 'A structured metric; never an open item.', flags: [['--stream <name>', 'the stream it belongs to']] },
    { name: 'carry', args: '<id>', summary: 'Re-home an item to another stream.', flags: [['--to <stream>', 'the destination stream (required)']] },
    { name: 'retro', args: '<stream>', summary: 'Draft the epic retro document (status: draft).', flags: [['--out <path>', 'where to write it'], ['--force', 'overwrite an existing file']] },
    { name: 'archive', args: '<stream>', summary: 'Hide a finished stream; refuses until retro and promotions are done.', flags: [] },
    { name: 'unarchive', args: '<stream>', summary: 'Bring an archived stream back, exactly.', flags: [] },
    { name: 'claim', args: '<repo>', summary: 'Take a repo lock.', flags: [['--desk <stream>', 'the desk taking it (required)'], ['--worktree <w>', 'scope the lock to a worktree'], ['--branch <b>', 'scope the lock to a branch'], ['--why "<text>"', 'reason'], ['--pid <n>', 'process that holds it']] },
    { name: 'lease', args: '<id>', summary: 'Take or renew this window\'s lease on an open item.', flags: [['--ttl <minutes>', 'lease length'], ['--steal [window]', 'take it from another window']] },
    { name: 'release', args: '<repo>[@<scope>] | <id>', summary: 'Drop a repo lock, or an item lease when the argument is the id of a leased item.', flags: [
        ['--desk <stream>', 'repo lock: the holding desk (required unless --force)'], ['--worktree <w>', 'repo lock: the worktree the lock is scoped to'], ['--branch <b>', 'repo lock: the branch the lock is scoped to'],
        ['--from <window>', 'item lease with --force: free the lease only if this window holds it'], ['--force', 'release a lock or lease another desk or window holds']] },
    { name: 'claims', args: '', summary: 'List repo claims with a stale check.', flags: [['--stale-hours <n>', 'stale after this long (default 12)'], JSON_OUT] },
    { name: 'query', args: '', summary: 'Read-only, capped filter over ledger items.', flags: [
        ['--stream <name>', 'stream'], ['--id <id>', 'one item'], [`--status ${oneOf(QUERY_STATUSES)}`, 'status'], DATE, ['--since YYYY-MM-DD', 'range start'], ['--until YYYY-MM-DD', 'range end'],
        ['--model <name>', 'model'], ['--limit <n>', 'default 50, max 200'], JSON_OUT] },
    { name: 'ready-to-push', args: '', summary: 'Local branches with commits on no remote, per repo (read-only git).', flags: [['--repo <name>', 'one repo'], JSON_OUT] },
    { name: 'brief', args: '<id>', summary: 'Write the dispatch brief file for an open item and take the repo claim.', flags: [
        ['--repo <name>', 'repo'], ['--desk <stream>', 'desk'], ['--worktree <w>', 'worktree'], ['--branch <b>', 'branch'], ['--next "<step>"', 'next step'], ['--as <holder>', 'who holds the repo claim (default: the desk)'], ['--pid <n>', 'process that holds the claim'], ['--read-only', 'a read-only brief'],
        ['--details-file <f>', 'extra details'], ['--done-when "<criteria>"', 'done criteria'], ['--out-dir <d>', 'where the brief goes']] },
    { name: 'next', args: '<id> "<step>"', summary: 'Record what an open item does next, and where its work lives.', flags: [['--worktree <w>', 'worktree'], ['--branch <b>', 'branch']] },
    { name: 'recover', args: '<id>', summary: 'Print a re-dispatch prompt for an open item (read-only).', flags: [] },
    { name: 'backfill', args: '', summary: 'Propose a stream for untagged items; writes nothing unless --apply.', flags: [['--dry-run', 'propose only'], ['--samples <n>', 'sample size'], ['--out <report.md>', 'write the report'], ['--apply', 'append tag events'], ['--min-confidence high|medium|low', 'with --apply'], JSON_OUT] },
    { name: 'triage', args: '', summary: 'Box every open item, flag stale and unticketed ones, print the don\'t-miss.', flags: [DATE, ['--since YYYY-MM-DD', 'range start'], ['--apply', 'apply the proposed changes'], JSON_OUT] },
    { name: 'defer', args: '<id>', summary: 'Hide an open item from the board until a future date.', flags: [['--until YYYY-MM-DD', 'required, in the future']] },
    { name: 'prime', args: '', summary: 'The box view for session start: 40 lines or fewer.', flags: [['--no-update-check', 'skip the fetch of this skill\'s checkout'], ['--source startup|compact', 'why it is running']] },
    { name: 'tickets', args: '', summary: 'Done items carrying a tracker key with no recorded transition.', flags: [['--pending', 'required'], ['--since YYYY-MM-DD', 'default 14 days back'], JSON_OUT] },
    { name: 'handoff', args: '', summary: 'Scaffold the five-part handoff note. Writes.', flags: [
        ['--stream <name>', 'one stream'], ['--all', 'every active stream'], ['--learn "<text>"', 'fill section 2'], ['--next "<text>"', 'fill section 5'], ['--update-context', 'link it from CONTEXT.md'], ['--context-file <path>', 'with --update-context'],
        ['--out <path>', 'where to write it'], ['--since YYYY-MM-DD', 'range start'], ['--delta', 'only what changed since today\'s earlier handoff'], ['--force', 'overwrite'], CONTAINER, ['--no-worktree-sweep', 'skip the cleanup candidates']] },
    { name: 'resume', args: '', summary: 'The verify-on-resume checklist, running the parts a script can run.', flags: [] },
    { name: 'priorities', args: 'set "<text>" [...] | show', summary: 'Write or read today\'s ranked priorities.', flags: [DATE, STATUS_DIR, JSON_OUT] },
    { name: 'week', args: 'set "<goal>" [...] | show', summary: 'Write or read this week\'s goals.', flags: [DATE, STATUS_DIR, JSON_OUT] },
    { name: 'start-here', args: '', summary: 'The first page a fresh reader needs, as text (80 lines at most).', flags: [['--stream <name>', 'one stream\'s tab'], STATUS_DIR, JSON_OUT] },
    { name: 'notes-check', args: '', summary: 'Durable notes no stream tab lists. Exit 0 none, 1 some, 2 unreadable.', flags: [['--since 30d|YYYY-MM-DD', 'window (default notes_check_since)'], ['--all', 'ignore the window'], JSON_OUT] },
    { name: 'standing', args: 'list|check|add <id>|done <id>|retire <id>', summary: 'Duties to pick up without a reminder.', flags: [
        ['--trigger "<when>"', 'add: what makes this duty due'], ['--action "<what>"', 'add: what to do'], ['--who "<who>"', 'add: who does it'], ['--check <name>', 'add: a runtime check (give this or --every-hours)'],
        ['--every-hours <n>', 'add: due again this many hours after it was last done'], ['--evidence "<text>"', 'done: what you did, with a link or id; required when the row has no --check'], JSON_OUT] },
    { name: 'podium', args: '', summary: 'Regenerate the Podium page (alias: status-page).', flags: [['--snapshot', 'also write the dated copy'], STATUS_DIR] },
    { name: 'status-page', args: '', summary: 'Alias of podium.', flags: [['--snapshot', 'also write the dated copy'], STATUS_DIR] },
    { noProject: true, name: 'web', args: '', summary: 'Serve the Podium read-only on 127.0.0.1.', flags: [['--port <n>', 'port'], STATUS_DIR] },
    { noProject: true, name: 'autopull', args: 'on|off', summary: 'Fast-forward this checkout at session start when it is clean and behind.', flags: [] },
    { noProject: true, name: 'settings', args: '[path...]', summary: 'The settings in effect, with where each came from.', flags: [['--all', 'include unset ones'], ['--check', 'flag known settings given a literal value in a note']] },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** True when `name` is a command in the table. */
export const isCommand = (name: string | undefined): boolean => name !== undefined && BY_NAME.has(name);

/** The arguments before a `--` terminator; after it everything is literal text, so `log -- --help` is not a help request. */
const beforeTerminator = (argv: string[]): string[] => (argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv);

/** True when argv asks for help: `help` first, or `--help` or `-h` before any `--`. Checked before anything runs. */
export function wantsHelp(argv: string[]): boolean {
    const flags = beforeTerminator(argv);
    return flags[0] === 'help' || flags.includes('--help') || flags.includes('-h');
}

/** The command help is about: the word after `help`, the first word, or the word after a leading flag (`-h roll`). Undefined means the whole list. */
export function helpTarget(argv: string[]): string | undefined {
    const flags = beforeTerminator(argv);
    const word = flags[0] === 'help' ? flags[1] : flags[0]?.startsWith('-') ? (BY_NAME.has(flags[1] ?? '') ? flags[1] : undefined) : flags[0];
    return word === undefined || word.startsWith('-') ? undefined : word;
}

/** Every command with its one-line summary. */
export function listText(): string {
    const width = Math.max(...COMMANDS.map((c) => c.name.length));
    return [
        'journal.ts <command> [args] [flags]',
        '',
        ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
        '',
        'journal.ts <command> --help prints one command\'s usage. Help never runs the command or writes anything.',
    ].join('\n');
}

/** One command's usage: synopsis, summary, its flags, then the flags every command takes. */
export function commandText(c: CommandHelp): string {
    const lines = [`journal.ts ${[c.name, c.args].filter(Boolean).join(' ')} [flags]`, '', `  ${c.summary}`];
    const flags = (title: string, list: Flag[]): void => {
        if (!list.length) return;
        const width = Math.max(...list.map(([f]) => f.length));
        lines.push('', `${title}:`, ...list.map(([f, m]) => `  ${f.padEnd(width)}  ${m}`));
    };
    flags('Flags', c.flags);
    if (c.notes) lines.push('', ...c.notes);
    flags('Every command', c.noProject ? GLOBAL_FLAGS : [PROJECT_FLAG, ...GLOBAL_FLAGS]);
    return lines.join('\n');
}

/** The text and exit code for a help request, or for an unknown command. */
export function helpFor(argv: string[]): { text: string; code: number } {
    const target = helpTarget(argv);
    if (target === undefined) return { text: listText(), code: 0 };
    const c = BY_NAME.get(target);
    return c ? { text: commandText(c), code: 0 } : { text: `Unknown command: ${target}\n\n${listText()}`, code: 1 };
}
