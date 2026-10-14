/**
 * Where a drafted reply to a comment on the person's own PR goes. The split is by who wrote the thread, decided here in code from what GitHub says:
 *   - a thread with ANY human in it becomes a queued draft (source `reply`) and waits for Approve, Edit or Reject on the Podium's Open PRs tab;
 *   - a thread whose every other participant is a bot is answered directly by `postBotReply` (fix-and-resolve, or a reasoned decline and resolve).
 * Nothing here posts a human thread's reply: `addDraft` refuses a reply addressed to a bot, `postBotReply` refuses a thread with a human in it, and
 * this module has no other way to write to GitHub. A reply may not mention an assistant or a tool, and is written in the person's voice.
 */
import { addDraft } from '../drafts/queue.ts';
import { postBotReply } from '../drafts/post.ts';
import type { GhRun } from '../drafts/post.ts';
import { voiceProblem } from '../teammate/bar.ts';
import { fetchThreads } from './threads.ts';

export const REPLY_KINDS = ['fixed', 'decline', 'question'] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
/** One reply as the drafting agent reports it. Every field is untrusted. */
export interface ReplyIn { commentId?: number; kind?: string; text?: string }

export type Routed =
  | { commentId: number; route: 'queued'; id: string; created: boolean }
  | { commentId: number; route: 'posted'; resolved: boolean; note?: string }
  | { commentId: number; route: 'refused'; reason: string };

const KIND_WORDS: Record<ReplyKind, string> = { fixed: 'Fix noted', decline: 'Decline, with the reason', question: 'Question back' };

/** Routes each reply. `self` must be the PR's author. Returns one result per reply, never throws for a bad reply. */
export function routeReplies(file: string, o: { repo: string; pr: number; self: string; replies: readonly ReplyIn[]; run: GhRun; now?: () => Date }): Routed[] {
  const pr = fetchThreads(o.repo, o.pr, o.self, o.run);
  if (pr.author.toLowerCase() !== o.self.toLowerCase() || !pr.open) throw new Error('that is not your own open PR: replies are only drafted on your PRs');
  return o.replies.map((r): Routed => {
    const commentId = Number.isSafeInteger(r.commentId) ? (r.commentId as number) : 0;
    const kind = REPLY_KINDS.find((k) => k === r.kind);
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!kind) return { commentId, route: 'refused', reason: `kind must be one of ${REPLY_KINDS.join(', ')}` };
    const bad = voiceProblem(text);
    if (bad) return { commentId, route: 'refused', reason: bad };
    const t = pr.threads.find((x) => x.rootId === commentId);
    if (!t || !t.waitingOn) return { commentId, route: 'refused', reason: 'no unresolved thread is waiting on you with that comment id' };
    if (t.kind === 'bot') {
      const out = postBotReply(file, { repo: o.repo, pr: o.pr, self: o.self, rootId: t.rootId, text, resolve: kind !== 'question' }, { run: o.run, ...(o.now ? { now: o.now } : {}) });
      return out.ok ? { commentId, route: 'posted', resolved: out.resolved, ...(out.note ? { note: out.note } : {}) } : { commentId, route: 'refused', reason: out.message };
    }
    const last = t.waitingOn;
    // The reply is addressed to the last person in the thread, even when a bot spoke after them.
    const them = [...t.comments].reverse().find((c) => !c.bot && c.author.toLowerCase() !== o.self.toLowerCase()) ?? last;
    const asked = `${KIND_WORDS[kind]}. ${them.author || 'A deleted account'} wrote: ${them.body.replace(/\s+/g, ' ').trim()}`;
    try {
      const out = addDraft(file, {
        key: `${o.repo}#${o.pr}:reply:${t.rootId}@${last.id}`, source: 'reply', repo: o.repo, pr: o.pr, severity: 'reply', text,
        target: { kind: 'reply', commentId: t.rootId }, replyTo: them.author || 'unknown', context: asked.slice(0, 500),
      }, o.now ? { now: o.now } : {});
      return { commentId, route: 'queued', id: out.id, created: out.created };
    } catch (e) { return { commentId, route: 'refused', reason: (e as Error).message }; }
  });
}
