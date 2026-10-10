import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** The message's own marker: its timestamp plus a short hash of its text, so two messages in the same millisecond never share one. It is the only memory of what was raised. */
export const hitMarker = (m: UserMessage): string => `[msg ${m.ts} ${createHash('sha1').update(m.text).digest('hex').slice(0, 6)}]`;

/** Decisions per ask row: a run raises every unhandled hit, in rows of this many, so a long session costs a few journal calls and never leaves a remainder to lose. */
export const DECISIONS_PER_ASK = 20;

/**
 * Messages that look like decisions and are not handled. A message is handled only when its own marker (`hitMarker`) is on
 * a ledger row's text, which is how an earlier run's ask remembers it. Nothing else counts: not a row written near it in
 * time, not an ask about something else, and not a rule or decision row that merely resembles it (a recorded decision
 * would hide its own reversal), so a decision is never hidden by its neighbours and the hook may be noisy but loses none.
 * There is no time cutoff, so another session's compaction cannot hide this transcript's decisions.
 * Every pending hit is raised, ordered by time then marker, as ask texts of at most DECISIONS_PER_ASK messages each
 * (clipped, and withheld when the text carries a secret or PHI shape); `count` is how many messages they carry.
 */
export function unledgeredDecisions(messages: UserMessage[], rows: LedgerRow[]): { raise: string[]; count: number } {
    const texts = rows.map((r) => r.text ?? '');
    const hits = messages.filter((m) => m.text.length >= 12 && m.text.length <= 1500 && DECISION_RE.test(m.text))
        .map((m) => ({ m, marker: hitMarker(m) }))
        .filter(({ marker }) => !texts.some((t) => t.includes(marker)))
        .sort((x, y) => (x.m.ts + x.marker).localeCompare(y.m.ts + y.marker));
    const line = ({ m, marker }: { m: UserMessage; marker: string }): string => `${marker} ${scanText(m.text).length ? '(text withheld: secret or PHI shape)' : clip(m.text.replace(/\s+/g, ' '), 110)}`;
    const raise: string[] = [];
    for (let i = 0; i < hits.length; i += DECISIONS_PER_ASK) {
        const batch = hits.slice(i, i + DECISIONS_PER_ASK);
        raise.push(`unledgered decision? (${batch.length}) ${batch.map(line).join(' || ')}`);
    }
    return { raise, count: hits.length };
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

export interface SnapshotResult { worktrees: number; /** Files copied this run; same as `copied`, kept for older callers. */ files: number; /** Files copied this run because today's and yesterday's snapshots lacked identical bytes. */ copied: number; /** Files already held, byte for byte, in today's or yesterday's snapshot: not copied, not counted against the caps. */ current: number; skipped: number; dest: string; /** True when the deadline stopped the scan before every worktree was read. */ partial: boolean; /** True when the file-count or total-size cap left source uncopied. */ capped: boolean }

/** The sibling of a `<date>`-named snapshot dir for the previous UTC date, or null when `dest` is not named by a date. */
function previousDayDir(dest: string): string | null {
    const date = basename(dest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return join(dirname(dest), new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
}

/** True when `path` is a regular file holding exactly `bytes` (size first, then content). */
function sameBytes(path: string, bytes: Buffer): boolean {
    try {
        const st = lstatSync(path);
        return st.isFile() && st.size === bytes.length && readFileSync(path).equals(bytes);
    } catch { return false; }
}

/**
 * Copies dirty and untracked source of the active worktrees under `container/.worktrees` to `dest/<worktree>/<path>`.
 * Only regular files (never a symlink, whatever it points at) that pass `isSnapshotSource` and not `isSecretName`;
 * skips files over 1 MB and files whose text carries a secret or PHI shape (counted, never named by content). Idempotent:
 * a file whose bytes already sit at the same path in `dest` or in the sibling dir of the previous UTC date is counted in `current`
 * and not copied (byte compare, since copyFileSync does not keep mtime); only copied bytes count toward the caps.
 * Stops at 300 files or 20 MB (`capped` is then true) or at `deadline` (epoch ms; `partial` is then true). `dest`'s parent gets a `.gitignore` of `*`,
 * so a snapshots folder inside a repo can never be committed. Never throws for one bad worktree.
 */
export function snapshotDirty(container: string, dest: string, now: number = Date.now(), deadline: number = Infinity): SnapshotResult {
    const root = join(container, '.worktrees');
    const result: SnapshotResult = { worktrees: 0, files: 0, copied: 0, current: 0, skipped: 0, dest, partial: false, capped: false };
    let total = 0;
    const held = [dest, previousDayDir(dest)].filter((d): d is string => d !== null);
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
            let bytes: Buffer | null = null;
            let hasShape = false;
            try { bytes = readFileSync(src); hasShape = scanText(bytes.toString('utf8')).length > 0; } catch { hasShape = true; }
            if (hasShape || !bytes) { result.skipped++; continue; }
            if (held.some((d) => sameBytes(join(d, name, p), bytes))) { result.current++; continue; }
            if (result.copied >= SNAPSHOT_MAX_FILES || total + size > SNAPSHOT_MAX_TOTAL_BYTES) { result.skipped++; result.capped = true; continue; }
            mkdirSync(dirname(join(dest, name, p)), { recursive: true });
            copyFileSync(src, join(dest, name, p));
            result.copied++;
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
/** Rows the continuity tick (the event loop's counterpart of the hook) writes carry this, so they never stale the handoff either. */
export const LOOP_USED = 'loop:continuity';
const byHook = (r: LedgerRow): boolean => { const used = JSON.stringify(r.used ?? ''); return used.includes(HOOK_USED) || used.includes(LOOP_USED); };
const starts = (r: LedgerRow, prefix: string): boolean => (r.text ?? '').startsWith(prefix);

/**
 * Whether `handoff` covers the ledger: it is fresh when it was generated at or after the newest row that is neither a
 * precompact marker nor written by the hook or the loop (those rows follow their own handoff and are not missed work).
 * `behindMs` is 0 when fresh; `lastRowTs` is that newest row's timestamp, null when none.
 * With no handoff at all `behindMs` is Infinity.
 */
export function handoffFresh(rows: LedgerRow[], handoff: { name: string; at: string } | null): { fresh: boolean; behindMs: number; lastRowTs: string | null } {
    const lastRowTs = rows.findLast((r) => r.ts && !isMark(r) && !byHook(r))?.ts ?? null;
    if (!handoff) return { fresh: false, behindMs: Infinity, lastRowTs };
    if (!lastRowTs || handoff.at >= lastRowTs) return { fresh: true, behindMs: 0, lastRowTs };
    return { fresh: false, behindMs: Math.max(0, Date.parse(lastRowTs) - Date.parse(handoff.at)) || 0, lastRowTs };
}

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
    const covered = handoffFresh(rows.slice(0, cut), handoff);
    if (covered.lastRowTs && !covered.fresh) {
        lines.push(`!! HANDOFF STALE: ${handoff ? `the newest handoff (${handoff.name}, ${handoff.at})` : 'there is no handoff'}, but the last ledger row before the compaction at ${mark.ts} is ${covered.lastRowTs}. Run ${REMEDY} now.`);
    }
    return lines;
}
