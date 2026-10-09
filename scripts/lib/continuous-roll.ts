import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanText } from './secret-scan.ts';
import { clip } from './journal/format.ts';
import type { LedgerRow } from './ledger-core.ts';

/**
 * The pure and file-level parts of the continuous roll: what the PreCompact hook finds (unledgered decisions, dirty
 * worktree source) and what `prime` checks afterwards (the precompact marker, a stale handoff). The hook scripts in
 * scripts/hooks only wire these to stdin, the ledger CLI and the clock.
 */

/** A ledger row the PreCompact hook writes starts with this, so prime can find the newest compaction marker. */
export const PRECOMPACT_MARK = 'precompact';
export const PRECOMPACT_INCOMPLETE = 'precompact incomplete';
/** Written before any slow work, so a hook killed by its timeout still leaves a trace. */
export const PRECOMPACT_STARTED = 'precompact started';
/** Written by a person (or `journal.ts log`) to dismiss an alarm whose cause needs no handoff. */
export const PRECOMPACT_ACK = 'precompact ack';
const DECISION_COVER_MS = 30 * 60_000;
const SNAPSHOT_MAX_FILE_BYTES = 1_000_000;
const SNAPSHOT_MAX_FILES = 300;
const SNAPSHOT_MAX_TOTAL_BYTES = 20_000_000;
/** A worktree whose newest dirty file is older than this is treated as abandoned, not in flight. */
export const SNAPSHOT_ACTIVE_MS = 72 * 3_600_000;

export interface UserMessage { ts: string; text: string }

/** What a person typed, from a transcript (JSON lines): user turns that are text, not tool results or injected reminders. */
export function userMessages(transcript: string): UserMessage[] {
    const out: UserMessage[] = [];
    for (const line of transcript.split('\n')) {
        if (!line.includes('"user"')) continue;
        let row: { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } };
        try { row = JSON.parse(line); } catch { continue; }
        if (row.type !== 'user' || row.isMeta || !row.timestamp) continue;
        const c = row.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => (b?.type === 'text' ? b.text ?? '' : '')).join('\n') : '';
        const t = text.trim();
        if (t && !t.startsWith('<') && !t.includes('<system-reminder>')) out.push({ ts: row.timestamp, text: t });
    }
    return out;
}

/** Words that mark a message as a decision, an approval or a standing rule. Deliberately broad: a hit is a question to Jack, not a fact. */
export const DECISION_RE = /\b(approved?|go ahead|go for it|ship it|decided|from now on|standing|always|never|ok(?:ay)? to|you may|let'?s go with|instead of|stop doing|do not|don'?t|yes,? (?:do|merge|push|open))\b/i;

/** A row that records a decision. Not the asks this hook raised itself: those are only questions about other messages, and counting them would mark every other recent decision as recorded. */
const covers = (r: LedgerRow): boolean => (['decision', 'rule', 'learned', 'resolved', 'ask', 'question'].includes(r.kind ?? '') || Boolean(r.approval))
    && !JSON.stringify(r.used ?? '').includes('hook:precompact') && !(r.text ?? '').startsWith('unledgered decision?');

/** The message's own marker inside a row's text: how a later compaction knows this hit was already raised. */
export const hitMarker = (ts: string): string => `[msg ${ts}]`;

/** At most this many hits are raised per run, oldest first; the rest stay unraised and the next run takes them. */
export const MAX_DECISION_HITS_PER_RUN = 10;

/**
 * Messages that look like decisions, have no ledger row that could record them within 30 minutes after, and that no earlier
 * run has already raised (the `[msg <ts>]` marker in a ledger row is the only memory; there is no time cutoff, so another
 * session's compaction can never hide this transcript's decisions). Returns every pending hit, oldest first: `raise` is the
 * first MAX_DECISION_HITS_PER_RUN of them as ask text (clipped, withheld when the text carries a secret or PHI shape), and
 * `pending` counts the hits left for the next run.
 */
export function unledgeredDecisions(messages: UserMessage[], rows: LedgerRow[]): { raise: string[]; pending: number } {
    const stamped = rows.filter((r) => r.ts);
    const hits = messages.filter((m) => m.text.length >= 12 && m.text.length <= 1500 && DECISION_RE.test(m.text))
        .filter((m) => !stamped.some((r) => (r.text ?? '').includes(hitMarker(m.ts))))
        .filter((m) => !stamped.some((r) => covers(r) && r.ts! >= m.ts && Date.parse(r.ts!) - Date.parse(m.ts) <= DECISION_COVER_MS));
    const raise = hits.slice(0, MAX_DECISION_HITS_PER_RUN).map((m) => `unledgered decision? ${hitMarker(m.ts)} ${scanText(m.text).length ? '(text withheld: secret or PHI shape)' : clip(m.text.replace(/\s+/g, ' '), 140)}`);
    return { raise, pending: hits.length - raise.length };
}

/** The line of a failed child's stderr that says why: the first `...Error: ...` line, else the last line (never the trailing "Node.js v24" banner). */
export function errorLine(stderr: string): string {
    const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => /\b\w*Error\b.*:/.test(l)) ?? lines.at(-1) ?? '';
}

/** Paths (relative) git reports as modified, added or untracked in a worktree; deletions are not files to keep. */
export function dirtyPaths(porcelainZ: string): string[] {
    const parts = porcelainZ.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let k = 0; k < parts.length; k++) {
        const status = parts[k].slice(0, 2);
        const path = parts[k].slice(3);
        if (/[RC]/.test(status)) k++; // the entry after a rename or copy is its source
        if (!status.includes('D')) paths.push(path);
    }
    return paths;
}

/** Names that never go in a snapshot even if their extension would pass; a second line behind the allowlist. */
const SECRET_NAME = /(^|\/)(secrets?(\..*)?|credentials(\..*)?|.*\.(pem|key|p12|pfx|tfstate|tfvars)|id_[a-z0-9]+)$/i;
export const isSecretName = (path: string): boolean => SECRET_NAME.test(path) || path.split('/').includes('node_modules');

/**
 * What a snapshot may copy: source and docs by extension, and a few config files by exact name. Everything else (every
 * dotfile, .json, .yml, .toml, .conf, any binary) is left out, because a denylist of secret names always misses one.
 */
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.sh', '.sql', '.md', '.css', '.html', '.tf']);
const SOURCE_NAMES = new Set(['package.json', 'tsconfig.json', 'Makefile', 'Dockerfile', 'pyproject.toml']);
export const isSnapshotSource = (path: string): boolean => SOURCE_EXT.has(extname(path).toLowerCase()) || SOURCE_NAMES.has(basename(path));

export interface SnapshotResult { worktrees: number; files: number; skipped: number; dest: string; /** True when the deadline stopped the scan before every worktree was read. */ partial: boolean; /** True when the file-count or total-size cap left source uncopied. */ capped: boolean }

/**
 * Copies dirty and untracked source of the active worktrees under `container/.worktrees` to `dest/<worktree>/<path>`.
 * Only regular files (never a symlink, whatever it points at) that pass `isSnapshotSource` and not `isSecretName`;
 * skips files over 1 MB and files whose text carries a secret or PHI shape (counted, never named by content). Idempotent.
 * Stops at 300 files or 20 MB (`capped` is then true) or at `deadline` (epoch ms; `partial` is then true). `dest`'s parent gets a `.gitignore` of `*`,
 * so a snapshots folder inside a repo can never be committed. Never throws for one bad worktree.
 */
export function snapshotDirty(container: string, dest: string, now: number = Date.now(), deadline: number = Infinity): SnapshotResult {
    const root = join(container, '.worktrees');
    const result: SnapshotResult = { worktrees: 0, files: 0, skipped: 0, dest, partial: false, capped: false };
    let total = 0;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(join(dirname(dest), '.gitignore'), '*\n');
    for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
        if (Date.now() > deadline) { result.partial = true; break; }
        const wt = join(root, name);
        const git = spawnSync('git', ['-C', wt, 'status', '--porcelain=v1', '-z', '-uall'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64_000_000 });
        if (git.status !== 0) { if (git.error) result.skipped++; continue; }
        const regular = (p: string): { size: number; mtimeMs: number } | null => { try { const st = lstatSync(join(wt, p)); return st.isFile() ? st : null; } catch { return null; } };
        const live = dirtyPaths(git.stdout).filter((p) => regular(p));
        if (!live.some((p) => now - (regular(p)?.mtimeMs ?? 0) < SNAPSHOT_ACTIVE_MS)) continue;
        result.worktrees++;
        for (const p of live) {
            const src = join(wt, p);
            const size = regular(p)?.size ?? Infinity;
            if (!isSnapshotSource(p) || isSecretName(p) || size > SNAPSHOT_MAX_FILE_BYTES) { result.skipped++; continue; }
            if (result.files >= SNAPSHOT_MAX_FILES || total + size > SNAPSHOT_MAX_TOTAL_BYTES) { result.skipped++; result.capped = true; continue; }
            let hasShape = false;
            try { hasShape = scanText(readFileSync(src, 'utf8')).length > 0; } catch { hasShape = true; }
            if (hasShape) { result.skipped++; continue; }
            mkdirSync(dirname(join(dest, name, p)), { recursive: true });
            copyFileSync(src, join(dest, name, p));
            result.files++;
            total += size;
        }
    }
    return result;
}

/** Newest `generated_at` among the handoff files in `dir` (marker, else mtime), as an ISO string with its file name; null when none. */
export function newestHandoff(dir: string): { name: string; at: string } | null {
    let best: { name: string; at: string } | null = null;
    for (const name of existsSync(dir) ? readdirSync(dir).filter((n) => /^HANDOFF-.*\.md$/.test(n)) : []) {
        const path = join(dir, name);
        const marker = readFileSync(path, 'utf8').match(/^generated_at: (\S+)$/m)?.[1];
        const at = marker ?? lstatSync(path).mtime.toISOString();
        if (!best || at > best.at) best = { name: basename(name), at };
    }
    return best;
}

const isMark = (r: LedgerRow): boolean => r.kind === 'note' && (r.text ?? '').startsWith(PRECOMPACT_MARK);
/** Rows the hook itself wrote after its handoff (the raised asks); they are not work the handoff missed. */
export const HOOK_USED = 'hook:precompact';
const byHook = (r: LedgerRow): boolean => JSON.stringify(r.used ?? '').includes(HOOK_USED);
const starts = (r: LedgerRow, prefix: string): boolean => (r.text ?? '').startsWith(prefix);

const REMEDY = '`journal.ts handoff --all --delta` (or `--force --out <file>` once the day\'s suffixes are used up)';
const ACK = `journal.ts log "${PRECOMPACT_ACK}" --kind note --model <name> --used tool:journal.ts`;

/** The session tag a precompact row carries ("session ab12cd34"), or '' for a row without one. */
const tagOf = (r: LedgerRow): string => (r.text ?? '').match(/session ([\w-]+)\)/)?.[1] ?? '';

/**
 * What prime says first after a compaction.
 * - A "started" row with no result of its own run after it (a later non-started `precompact` row with the same session tag,
 *   or an ack): the hook was killed. Only its completed row or an ack clears this; a newer handoff does not, since the hook's
 *   own handoff is written before the snapshot and the decision scan. Other sessions' rows do not hide it.
 * - The newest row an "incomplete": printed with its failed steps. When the handoff step failed, a newer handoff clears it;
 *   a snapshot or decisions failure needs no handoff and only an ack clears it.
 * - An "ack" as the newest row dismisses everything.
 * Separately, when the newest handoff predates the last ledger row written before this compaction began (before the run's
 * "started" row, so rows other writers add while the hook runs are not counted), the handoff missed work and the line says so.
 */
export function continuityLines(rows: LedgerRow[], handoff: { name: string; at: string } | null): string[] {
    const k = rows.findLastIndex(isMark);
    if (k < 0) return [];
    const mark = rows[k];
    if (starts(mark, PRECOMPACT_ACK)) return [];
    const lines: string[] = [];
    const finished = (i: number): boolean => rows.slice(i + 1).some((r) => isMark(r) && !starts(r, PRECOMPACT_STARTED) && (starts(r, PRECOMPACT_ACK) || tagOf(r) === tagOf(rows[i])));
    const unfinished = rows.findLastIndex((r, i) => starts(r, PRECOMPACT_STARTED) && !finished(i));
    if (unfinished >= 0) lines.push(`!! ${clip(rows[unfinished].text ?? '', 200)} (${rows[unfinished].ts}) never finished: the hook was killed or failed before it wrote its result, so the snapshot or the decision scan may not have run. Run ${REMEDY}, then dismiss with \`${ACK}\`.`);
    // An incomplete row stays until its own session writes a later success row, an ack follows it, or (handoff failures only) a newer handoff exists.
    // Another session's success says nothing about this one's failed step.
    const cleared = (i: number): boolean => rows.slice(i + 1).some((r) => starts(r, PRECOMPACT_ACK) || (isMark(r) && starts(r, `${PRECOMPACT_MARK}:`) && tagOf(r) === tagOf(rows[i])))
        || (/\bhandoff: /.test(rows[i].text ?? '') && handoff !== null && handoff.at > (rows[i].ts ?? ''));
    rows.forEach((r, i) => {
        if (!starts(r, PRECOMPACT_INCOMPLETE) || cleared(i)) return;
        const needsHandoff = /\bhandoff: /.test(r.text ?? '');
        lines.push(`!! ${clip(r.text ?? '', 260)} (${r.ts}). ${needsHandoff ? `Run ${REMEDY}, or dismiss` : 'A handoff does not fix this; dismiss'} with \`${ACK}\`.`);
    });
    const started = rows.slice(0, k + 1).findLastIndex((r) => starts(r, PRECOMPACT_STARTED) && tagOf(r) === tagOf(mark));
    const cut = started >= 0 ? started : k;
    const before = rows.slice(0, cut).findLast((r) => r.ts && !isMark(r) && !byHook(r));
    if (before?.ts && (!handoff || handoff.at < before.ts)) {
        lines.push(`!! HANDOFF STALE: ${handoff ? `the newest handoff (${handoff.name}, ${handoff.at})` : 'there is no handoff'}, but the last ledger row before the compaction at ${mark.ts} is ${before.ts}. Run ${REMEDY} now.`);
    }
    return lines;
}
