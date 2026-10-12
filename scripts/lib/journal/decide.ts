/**
 * `journal.ts decide`: a decision written where it will be found, on the turn it is said. Pure checks and renderers plus
 * the two file writers; the CLI adds the ledger row after a writer succeeds and calls `undo` when the row cannot be written,
 * so a file never claims a ledger row that is not there and a ledger row never names a file that was not written.
 *
 * Two scopes: `project` appends a dated entry to the project's DECISIONS.md; `working-rule` writes (or updates) a memory
 * file and its one index line under a configured memory directory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanFields, describeFindings } from '../secret-scan.ts';
import type { LedgerRow } from '../ledger-core.ts';

export const SCOPES = ['project', 'working-rule'] as const;
export type Scope = (typeof SCOPES)[number];

export interface DecideInput {
    decision: string; why: string; rejected?: string; consequence?: string; scope: Scope; date: string;
    /** working-rule only: names the memory file, so a changed rule on the same topic updates it. Defaults to the decision's first words. */
    topic?: string;
}

/** What a writer did: the file it wrote, whether it was already there, and how to put the disk back if the ledger write fails. */
export interface Written { path: string; kind: 'created' | 'updated' | 'unchanged'; undo: () => void }

export const FIELD_MAX = 600;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Every reason to refuse before any write; none echoes a field's value, since the value that failed may be the secret. */
export function decideProblems(i: Partial<DecideInput>): string[] {
    const out: string[] = [];
    const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    if (!text(i.decision)) out.push('a decision needs its text: journal.ts decide "<decision>" --why "<rationale>"');
    if (!text(i.why)) out.push('--why is required: a decision without a reason is refused. Say why it was decided.');
    if (!i.scope || !(SCOPES as readonly string[]).includes(i.scope)) out.push(`--scope must be one of: ${SCOPES.join(', ')}.`);
    if (!text(i.date) || !DATE.test(i.date)) out.push('--date must be YYYY-MM-DD.');
    if (i.topic !== undefined && !SLUG.test(i.topic)) out.push('--topic must be lowercase words joined by hyphens.');
    for (const [name, v] of Object.entries({ decision: i.decision, why: i.why, rejected: i.rejected, consequence: i.consequence })) {
        if (typeof v === 'string' && v.length > FIELD_MAX) out.push(`${name} is over ${FIELD_MAX} characters: say it shorter.`);
        if (typeof v === 'string' && /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) out.push(`${name} has a control character: plain text only.`);
    }
    const found = scanFields({ decision: i.decision, why: i.why, rejected: i.rejected, consequence: i.consequence, topic: i.topic });
    return [...out, ...describeFindings(found)];
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The DECISIONS.md entry: a dated heading, then the decision, rationale, rejected alternatives and consequence. */
export function renderEntry(i: DecideInput): string {
    return [
        `## ${i.date}: ${clip(oneLine(i.decision), 90)}`, '',
        `- **Decision:** ${oneLine(i.decision)}`,
        `- **Rationale:** ${oneLine(i.why)}`,
        `- **Rejected alternatives:** ${i.rejected ? oneLine(i.rejected) : 'none recorded'}`,
        `- **Consequence:** ${i.consequence ? oneLine(i.consequence) : 'none recorded'}`,
        '',
    ].join('\n');
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

/** A way back for one file: put the old text back, or remove the file if it did not exist. */
function undoFor(path: string, before: string | null): () => void {
    return () => { if (before === null) rmSync(path, { force: true }); else writeAtomic(path, before); };
}

/**
 * Adds the entry to a project's DECISIONS.md, newest first, under the `# Decisions` heading (created when the file is new).
 * Idempotent: an entry with the same heading and decision text is reported `unchanged` and nothing is written.
 */
export function writeProjectDecision(path: string, i: DecideInput): Written {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const entry = renderEntry(i);
    if (before !== null && before.includes(entry.trimEnd())) return { path, kind: 'unchanged', undo: () => {} };
    const head = '# Decisions\n\n';
    const body = before === null ? head : before.startsWith('# Decisions') ? before : `${head}${before}`;
    const at = body.indexOf('\n## ');
    const next = at < 0 ? `${body.trimEnd()}\n\n${entry}` : `${body.slice(0, at + 1)}${entry}\n${body.slice(at + 1)}`;
    writeAtomic(path, next);
    return { path, kind: 'created', undo: undoFor(path, before) };
}

/** The memory file's name for a topic: the explicit `--topic`, else the first six words of the decision, as a slug. */
export function topicSlug(i: Pick<DecideInput, 'decision' | 'topic'>): string {
    if (i.topic) return i.topic;
    const words = oneLine(i.decision).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean).slice(0, 6);
    return words.join('-') || 'rule';
}

/**
 * Writes the memory file for a working rule and its one line in MEMORY.md. A second call on the same topic rewrites the file
 * and replaces the index line rather than adding another. Both files are put back by `undo`.
 */
export function writeWorkingRule(memoryDir: string, i: DecideInput): Written {
    const slug = topicSlug(i);
    const path = join(memoryDir, `${slug}.md`);
    const indexPath = join(memoryDir, 'MEMORY.md');
    const beforeFile = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const beforeIndex = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    const title = clip(oneLine(i.decision), 70);
    const file = [
        '---', `name: ${slug}`, `description: ${JSON.stringify(clip(oneLine(i.decision), 160))}`, 'metadata:', '  type: feedback', '---', '',
        `${oneLine(i.decision)}`, '',
        `**Why:** ${oneLine(i.why)}`, '',
        ...(i.rejected ? [`**Rejected:** ${oneLine(i.rejected)}`, ''] : []),
        ...(i.consequence ? [`**Consequence:** ${oneLine(i.consequence)}`, ''] : []),
        `Recorded ${i.date} by \`journal.ts decide\`.`, '',
    ].join('\n');
    const line = `- [${title}](${slug}.md) — ${clip(oneLine(i.why), 110)}`;
    const lines = (beforeIndex ?? '').split('\n').filter((l, n, all) => l !== '' || n < all.length - 1);
    const at = lines.findIndex((l) => l.includes(`](${slug}.md)`));
    if (at >= 0) lines[at] = line; else lines.push(line);
    const index = `${lines.join('\n')}\n`;
    if (beforeFile === file && beforeIndex === index) return { path, kind: 'unchanged', undo: () => {} };
    const undo = (): void => { undoFor(path, beforeFile)(); undoFor(indexPath, beforeIndex)(); };
    try { writeAtomic(path, file); writeAtomic(indexPath, index); } catch (e) { undo(); throw e; }
    return { path, kind: beforeFile === null ? 'created' : 'updated', undo };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'are', 'was', 'will', 'should', 'when', 'only', 'then', 'than', 'have', 'has', 'its', 'any', 'all', 'use', 'now', 'never', 'always']);
const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

export interface Related { source: string; text: string; shared: string[] }

/**
 * The closest earlier decision on the same topic, so a reversal says what it reverses: DECISIONS.md headings and ledger
 * decision rows, scored by shared words. Needs at least three shared words, and half of the shorter side's words.
 */
export function relatedDecision(decision: string, decisionsMd: string | null, rows: readonly LedgerRow[]): Related | null {
    const mine = words(decision);
    const candidates: { source: string; text: string }[] = [
        ...(decisionsMd ?? '').split('\n').filter((l) => l.startsWith('## ')).map((l) => ({ source: 'DECISIONS.md', text: l.slice(3) })),
        ...rows.filter((r) => r.kind === 'decision' && !r.pending && typeof r.text === 'string').map((r) => ({ source: `ledger ${r.id ?? ''}`.trim(), text: r.text as string })),
    ];
    let best: (Related & { score: number }) | null = null;
    for (const c of candidates) {
        const theirs = words(c.text);
        const shared = [...mine].filter((w) => theirs.has(w));
        const score = shared.length / Math.max(1, Math.min(mine.size, theirs.size));
        if (shared.length >= 3 && score >= 0.5 && (!best || score > best.score)) best = { ...c, shared, score };
    }
    return best ? { source: best.source, text: best.text, shared: best.shared } : null;
}
