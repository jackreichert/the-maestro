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
    /** What must be true for the work to count as done, set by the dispatcher before the agent starts. */
    doneWhen?: string;
    /** A declared 1-point, one-file change: the planning sections were skipped on purpose, and the brief says so. */
    onePoint?: boolean;
    /** Whether this brief's agent writes to the repo (and so holds the repo claim). */
    writer: boolean;
    reportPath: string;
    /** How the agent runs journal.ts (for the retro command); default `journal.ts`. */
    journal?: string;
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

/**
 * The `Library pages for this task` section: the helper's block, or the reason there is none. A library lookup is advisory, so it fails open: a
 * lookup that cannot run (no vault set, no vault folder for the repo, task text with no words, a crash) puts one "unavailable" line in the brief
 * and the brief goes out. The section is never silently empty; the line says why.
 */
export function libraryBlock(run: (() => { status: number | null; stdout: string; stderr: string }) | null, reason: string): string {
    if (!run) return `Library pages for this task: none (${reason}).`;
    const r = run();
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    const why = ((r.stderr || r.stdout).trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').slice(0, 160);
    return `Library pages for this task: unavailable (library-brief failed, exit ${r.status ?? 'none'}${why ? `: ${why}` : ''}); look in the vault's Projects folder yourself.`;
}

/** The `## Retro` section: the exact command, with the item id filled in, so the agent records its lessons before it hands back. `done` refuses the item without one. */
export const retroSection = (id: string, journal: string): string => [
    '## Retro',
    'Before you hand back, while you still remember, write your retro: every lesson you got from the code or from the user, and anything else a later agent should know. One `--lesson` each, one line, starting with its source:',
    `\`\`\`bash\n${journal} agent-retro ${id} --lesson "code: <how the code really behaves>" --lesson "jack: <a preference or correction from the user>" --lesson "process: <what to do differently next time>" --model "<name>" --used "<marks>"\n\`\`\``,
    'A fact with evidence goes through `journal.ts learned` first; pass its id with `--learned <id>`. Nothing worth keeping: `--nothing "<why>"` instead of lessons. No secrets or PHI: names, ids and counts only. This item cannot be closed with `done` until its retro exists. Say in your report that you wrote it.',
].join('\n\n');

/** The brief file's text. */
export function briefText(b: BriefInput): string {
    const facts = [
        `Ledger item ${b.id}${b.stream ? ` (stream ${b.stream})` : ''}${b.ticket ? `, ticket ${b.ticket}` : ''}.`,
        b.repo ? `Repo: ${b.repo}${b.workingDir ? `, working directory ${b.workingDir}` : ''}. ${b.writer ? 'You hold the repo claim: you are its one writer.' : 'Read-only: no claim is held.'}` : 'No repo named.',
        ...(b.writer && b.onePoint ? ['Declared a 1-point, one-file change: no Invariants, Prior art or Prep refactor sections. If the work turns out larger, stop and say so.'] : []),
    ];
    const sections = [
        `# Brief ${b.id}`,
        `## Objective\n\n${b.text}\n\n${facts.join('\n')}`,
        b.details?.trim() ? `## Task details\n\n${b.details.trim()}` : '',
        `## Done when\n\n${b.doneWhen?.trim() || 'The dispatcher gave no criteria. Before you start, write the criteria you will check yourself against as the first lines of your report file.'}`,
        `## Library\n\n${b.library}`,
        `## Report\n\nWrite the full report to ${b.reportPath}. Hand back only a headline paragraph under ${HAND_BACK_WORDS} words plus that path: outcome, numbers, links, decisions needed, what is left open. If tests failed or a step was skipped, say so in the headline.\n\nThe report file states, so the next reader can pick the work up without you: the done criteria and whether each was met; your confidence and what it was measured on (a command and its result, not a feeling); what you tried that failed, with why; and who owns the work if you stop part-way (name the branch or worktree and the next step).`,
        retroSection(b.id, b.journal ?? 'journal.ts'),
        `## Standing rules\n\n${b.standing.trim()}`,
    ];
    return sections.filter(Boolean).join('\n\n') + '\n';
}
