/**
 * Recoverable ledger rows: where an item's work lives (worktree, branch), what it does next, and the prompt a cold session
 * uses to re-dispatch it. Pure text and one git probe; the commands in journal.ts do the ledger reads and writes.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { LedgerRow } from '../ledger-core.ts';

export interface Recovery { worktree?: string; branch?: string; nextStep?: string }

/** The recovery fields the flags carry. A relative worktree becomes absolute, and a worktree with no `--branch` names the branch it has checked out (nothing, when git cannot say). */
export function recoveryFromFlags(flags: { worktree?: string | null; branch?: string | null; next?: string | null }, probe: (dir: string) => string | undefined = currentBranch): Recovery {
    const worktree = flags.worktree ? resolve(flags.worktree) : undefined;
    const branch = flags.branch || (worktree ? probe(worktree) : undefined);
    return { ...(worktree ? { worktree } : {}), ...(branch ? { branch } : {}), ...(flags.next ? { nextStep: flags.next } : {}) };
}

/** The branch checked out in a directory, or undefined when it is not a git worktree, is detached, or git fails. */
export function currentBranch(dir: string): string | undefined {
    if (!existsSync(dir)) return undefined;
    const r = spawnSync('git', ['--no-optional-locks', '-C', dir, 'branch', '--show-current'], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** What git says about a live worktree: short status and the last commits (read without taking `index.lock` or refreshing the index, so a live agent's `git add` is never blocked), or the reason it could not be read. */
export function worktreeState(dir: string): { status: string; log: string } {
    const git = (args: string[]): string => {
        const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' });
        return r.status === 0 ? r.stdout.trim() : `(git ${args[0]} failed: ${(r.stderr || 'no output').trim().split('\n')[0]})`;
    };
    return { status: git(['status', '--short', '--branch']), log: git(['log', '-5', '--oneline']) };
}

export interface RecoverInput {
    item: LedgerRow;
    /** The latest brief row for the item, if any. */
    briefRow?: LedgerRow;
    /** The ticket note's path when it exists on disk. */
    ticketPath?: string;
    /** The "Library pages for this task" block. */
    library: string;
    /** Injected for tests. */
    state?: (dir: string) => { status: string; log: string };
}

/** The re-dispatch prompt: everything a fresh agent needs to pick the item up, and what it must verify first. A row with none of the recovery fields says so instead of guessing. */
export function recoverPrompt(r: RecoverInput): string {
    const { item } = r;
    const id = item.id as string;
    const out: string[] = [`Re-dispatch of ledger item ${id}: ${item.text ?? ''}`];
    out.push([item.stream ? `Stream: ${item.stream}.` : '', item.repo ? `Repo: ${item.repo}.` : '', item.ticket ? `Ticket: ${item.ticket}${r.ticketPath ? ` (${r.ticketPath})` : ''}.` : ''].filter(Boolean).join(' ') || 'No stream, repo or ticket on the row.');
    out.push(r.briefRow?.brief ? `Original brief: ${r.briefRow.brief} (read it first; the report goes to ${r.briefRow.report ?? 'the path in the brief'}).` : 'No brief file is recorded for this item; work from the text above and the ticket.');
    out.push(`Next step recorded: ${item.nextStep ?? 'none recorded (the row has no next step; read the work below and decide it)'}`);
    if (!item.worktree && !item.branch) {
        out.push('Worktree and branch: not recorded (an older row). Find the work with `git worktree list` in the repo and `git branch --list` for the ticket key before starting anything new.');
    } else {
        out.push(`Branch: ${item.branch ?? 'not recorded'}. Worktree: ${item.worktree ?? 'not recorded'}.`);
        if (item.worktree && existsSync(item.worktree)) {
            const s = (r.state ?? worktreeState)(item.worktree);
            out.push(`Worktree state (git status):\n${s.status}\nLast commits:\n${s.log}`);
        } else if (item.worktree) {
            out.push(`The worktree is missing: ${item.worktree} does not exist on this machine. Do not assume the work is lost: check whether the branch${item.branch ? ` ${item.branch}` : ''} exists locally or on origin, then recreate the worktree from it with \`git worktree add\`; if the branch is gone too, start again from the brief.`);
        }
    }
    out.push(r.library);
    out.push(`Rules: keep one writer per worktree, record progress with \`journal.ts next ${id} "<step>"\`, and close the item with \`journal.ts done ${id}\` only when the work is done.`);
    return out.join('\n\n');
}
