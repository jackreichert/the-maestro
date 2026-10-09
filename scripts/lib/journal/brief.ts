/**
 * The dispatch brief file written by `journal.ts brief <id>`: the pieces of a brief that must be exact (the standing block,
 * the library pages, the ledger text, the hand-back cap, the report path) put together in one place, so a dispatcher never
 * retypes them. Pure text; the command does the reads, the claim and the writes.
 */
import { join } from 'node:path';

/** The hand-back cap, in words, the report section states. */
export const HAND_BACK_WORDS = 150;

export interface BriefInput {
    id: string;
    text: string;
    stream?: string;
    repo?: string;
    ticket?: string;
    /** Absolute working directory, when the container and repo are known. */
    workingDir?: string;
    /** The "Library pages for this task" block, already formatted (or the reason there is none). */
    library: string;
    /** The standing brief block, filled. */
    standing: string;
    /** Task-specific text the dispatcher wrote (anchors, scope, verify), appended as given. */
    details?: string;
    /** Whether this brief's agent writes to the repo (and so holds the repo claim). */
    writer: boolean;
    reportPath: string;
}

/** The brief and report file paths for an item under a directory. */
/** A read-only brief gets its own files, so it can never be mistaken for the writer's (which says its agent holds the repo claim). */
export const briefPaths = (dir: string, id: string, writer = true): { brief: string; report: string } => {
    const mode = writer ? '' : '-ro';
    return { brief: join(dir, `brief-${id}${mode}.md`), report: join(dir, `report-${id}${mode}.md`) };
};

/** The one-line Agent prompt that points at a brief file. */
export const agentPrompt = (briefPath: string, reportPath: string): string =>
    `Your full brief is the file ${briefPath}. Read it first and follow it exactly. Write your report to ${reportPath} and hand back a headline under ${HAND_BACK_WORDS} words plus that path.`;

/** The `Library pages for this task` section: the helper's block, or the reason there is none. Never silently empty. */
export function libraryBlock(run: (() => { status: number | null; stdout: string; stderr: string }) | null, reason: string): { ok: true; text: string } | { ok: false; error: string } {
    if (!run) return { ok: true, text: `Library pages for this task: none (${reason}).` };
    const r = run();
    if (r.status !== 0 || !r.stdout.trim()) return { ok: false, error: `library-brief failed (exit ${r.status ?? 'none'}): ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`.trim() };
    return { ok: true, text: r.stdout.trim() };
}

/** The brief file's text. */
export function briefText(b: BriefInput): string {
    const facts = [
        `Ledger item ${b.id}${b.stream ? ` (stream ${b.stream})` : ''}${b.ticket ? `, ticket ${b.ticket}` : ''}.`,
        b.repo ? `Repo: ${b.repo}${b.workingDir ? `, working directory ${b.workingDir}` : ''}. ${b.writer ? 'You hold the repo claim: you are its one writer.' : 'Read-only: no claim is held.'}` : 'No repo named.',
    ];
    const sections = [
        `# Brief ${b.id}`,
        `## Objective\n\n${b.text}\n\n${facts.join('\n')}`,
        b.details?.trim() ? `## Task details\n\n${b.details.trim()}` : '',
        `## Library\n\n${b.library}`,
        `## Report\n\nWrite the full report to ${b.reportPath}. Hand back only a headline paragraph under ${HAND_BACK_WORDS} words plus that path: outcome, numbers, links, decisions needed, what is left open. If tests failed or a step was skipped, say so in the headline.`,
        `## Standing rules\n\n${b.standing.trim()}`,
    ];
    return sections.filter(Boolean).join('\n\n') + '\n';
}
