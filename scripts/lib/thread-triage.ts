/**
 * A reviewer's call on one open bot thread (Copilot, Aikido, any other bot): is it worth the author's attention, and does it block?
 * Stored on a review draft (`review.triage`), checked against GitHub's live threads at approve time by lib/approve-guard.ts, and rendered into the
 * review body as a short "Worth addressing before merge" list. `threadId` is the thread's root comment id (what `teammate-review.ts threads` prints) or its GraphQL node id.
 */
export interface ThreadTriage { threadId: string; worthAddressing: boolean; /** One line: why it matters, or why it does not. */ reason: string; /** `blocking` (a correctness bug, security, PHI, data loss, a deploy break) turns an approval into a COMMENT review. Only on a thread worth addressing. */ severity?: 'blocking' }

export const MAX_TRIAGE = 50;
const MAX_REASON = 200;
const THREAD_ID = /^[A-Za-z0-9_=-]{1,100}$/;

/** The reason a triage list is malformed, or null. Runs on every review draft that carries one, so a malformed entry never reaches the guard. */
export function triageProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length > MAX_TRIAGE) return `Triage is a list of at most ${MAX_TRIAGE} entries.`;
  for (const e of v as unknown[]) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'Bad triage entry.';
    const t = e as Record<string, unknown>;
    if (typeof t.threadId !== 'string' || !THREAD_ID.test(t.threadId)) return 'A triage entry needs the thread id.';
    if (typeof t.worthAddressing !== 'boolean') return 'A triage entry says worthAddressing true or false.';
    if (typeof t.reason !== 'string' || !t.reason.trim() || t.reason.length > MAX_REASON || /[\r\n]/.test(t.reason)) return `A triage reason is one line of at most ${MAX_REASON} characters.`;
    if (t.severity !== undefined && (t.severity !== 'blocking' || t.worthAddressing !== true)) return 'Only a thread worth addressing can be triaged blocking.';
  }
  return null;
}

/** The section appended to a review body, or '' when nothing is worth addressing. Threads the reviewer judged not worth it are never mentioned. */
export function worthSection(items: readonly { label: string; url: string; reason: string }[]): string {
  if (items.length === 0) return '';
  return `**Worth addressing before merge**\n${items.map((i) => `- [${i.label}](${i.url}): ${i.reason}`).join('\n')}`;
}
