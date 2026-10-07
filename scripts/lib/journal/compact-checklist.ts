/** Sources of a SessionStart hook for which `prime` prints the checklist; resume and clear keep their context, so they get none. */
export const CHECKLIST_SOURCES = ['startup', 'compact'] as const;
export const MAX_CHECKLIST_LINES = 12;

const CHECKLIST = [
  'After a compact (the reply rules do not survive one; redo these before the first reply):',
  '1. Re-read SKILL.md and CURRENT.md.',
  '2. Run `journal.ts priorities show` fresh and pick work by it.',
  '3. ListAgents. Footer: the **Agents:** line first (each agent named by its task), then the script footer verbatim.',
  '4. Reads and sweeps go to Haiku agents; relay headlines only.',
  '5. Parallel agents each get their own worktree: one writer per worktree.',
  '6. Is the event loop supervisor alive? Check its heartbeat or Loop status (else `ps`). Is the Podium running?',
  '7. Log `journal.ts start` and `done` for every dispatch.',
];

/** The always-printed post-compact checklist for a SessionStart source; empty for any source but startup and compact. */
export function compactChecklist(source: string | undefined): string[] {
  return (CHECKLIST_SOURCES as readonly string[]).includes(source ?? '') ? [...CHECKLIST] : [];
}
