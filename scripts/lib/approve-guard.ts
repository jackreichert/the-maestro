/**
 * The one check every APPROVE passes before it is posted. It reads GitHub live, at the moment of posting, and decides from three facts:
 *
 *   1. the PR's head is still the commit that was reviewed (a moved head means the review is of old code: refuse, re-review);
 *   2. every unresolved bot thread (Copilot, Aikido, any bot) carries a triage entry from the reviewer (lib/thread-triage.ts); a thread with none,
 *      such as one that landed after the review agent looked (dtr#4072, 2026-10-16), refuses and is listed so the reviewer triages it;
 *   3. a thread triaged `blocking` turns the approval into a COMMENT review. Threads triaged worth-addressing do not block: they are pointed out
 *      (the verdict lists them; the review body carries them), and the approval stands.
 *
 * Callers: the Podium's approve route (the draft poster in lib/drafts), `teammate-review.ts submit` (so the reviewer hears about it while the draft is queued) and
 * `approve-pr.ts` (manual approvals). A thread is a bot thread when a bot started it (lib/github-bots.ts, plus any login naming Copilot); every
 * unresolved one counts, whoever spoke last. A thread a person started never matters here. An unreadable head or thread list refuses: the guard
 * fails closed. A backmerge (head branch `backmerge/...` or `back-merge-...`) is exempt from the thread rules, never from the head rule.
 */
import { fetchThreads } from './replies/threads.ts';
import type { Thread } from './replies/threads.ts';
import type { ThreadTriage } from './thread-triage.ts';

export interface GhOut { status: number | null; stdout: string; stderr: string }
/** Runs `gh` with these arguments. Structurally the runner post.ts exports, declared here so this module does not depend on the posting module. */
export type GhRunner = (args: string[], input?: string) => GhOut;

export type ApproveRefusal = 'head-unreadable' | 'head-moved' | 'threads-unreadable' | 'untriaged';
export interface OpenBotThread { id: string; path: string; line: number | null; author: string; url: string; /** The bot's opening comment, clipped, so the reviewer can triage it. */ text: string }
export interface WorthThread extends OpenBotThread { reason: string }
export type ApproveVerdict =
  | { ok: true; event: 'APPROVE' | 'COMMENT'; worth: WorthThread[]; blocking: OpenBotThread[] }
  | { ok: false; code: ApproveRefusal; message: string; threads: OpenBotThread[] };

const BACKMERGE_HEAD = /^(backmerge\/|back-merge-)/i;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHOWN = 5;

/** True when a bot opened this thread. */
const botStarted = (t: Thread): boolean => { const root = t.comments[0]; return !!root && (root.bot || /copilot/i.test(root.author)); };

/** `where` names a thread for a person: who, and the line. */
export const whereOf = (t: OpenBotThread): string => `${t.author || 'a bot'} at ${t.path || 'the PR'}${t.line === null ? '' : `:${t.line}`} (thread ${t.id})`;
/** The label a thread gets in a list: the file and line. */
export const labelOf = (t: OpenBotThread): string => `${t.path || 'PR'}${t.line === null ? '' : `:${t.line}`}`;

function read(run: GhRunner, repo: string, pr: number, jq: string): string | null {
  let r: GhOut;
  try { r = run(['api', `repos/${repo}/pulls/${pr}`, '--jq', jq]); } catch { return null; }
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The unresolved bot threads on the PR, read live; throws when GitHub cannot say. */
export function openBotThreads(run: GhRunner, repo: string, pr: number): { thread: OpenBotThread; nodeId: string }[] {
  return fetchThreads(repo, pr, '', run).threads.filter(botStarted).map((t) => ({
    nodeId: t.nodeId,
    thread: { id: String(t.rootId), path: t.path, line: t.line, author: t.comments[0]?.author ?? '', url: `https://github.com/${repo}/pull/${pr}#discussion_r${t.rootId}`, text: (t.comments[0]?.body ?? '').slice(0, 400) },
  }));
}

/**
 * Decides whether an APPROVE of `repo#pr` may go out now, and as what. `reviewedHead` is the commit the review was of (a full sha, or the prefix a
 * draft stores); the live head must start with it. `triage` is the reviewer's list for the PR's bot threads. Never throws: whatever cannot be read is a refusal.
 */
export function checkApprove(run: GhRunner, repo: string, pr: number, reviewedHead: string, triage: readonly ThreadTriage[] = []): ApproveVerdict {
  const refuse = (code: ApproveRefusal, message: string, threads: OpenBotThread[] = []): ApproveVerdict => ({ ok: false, code, message, threads });
  const wanted = reviewedHead.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(wanted)) return refuse('head-unreadable', 'No reviewed commit was given, so an approval is not posted.');
  const head = (read(run, repo, pr, '.head.sha') ?? '').toLowerCase();
  if (!FULL_SHA.test(head)) return refuse('head-unreadable', 'Could not read the PR\'s current head from GitHub, so an approval is not posted.');
  if (!head.startsWith(wanted)) return refuse('head-moved', `The PR moved since the review (reviewed ${wanted.slice(0, 7)}, head is now ${head.slice(0, 7)}), so an approval is not posted. Re-review the new head.`);
  let open: { thread: OpenBotThread; nodeId: string }[];
  try { open = openBotThreads(run, repo, pr); } catch { return refuse('threads-unreadable', 'Could not read the PR\'s review threads from GitHub, so an approval is not posted.'); }
  if (open.length === 0 || BACKMERGE_HEAD.test(read(run, repo, pr, '.head.ref') ?? '')) return { ok: true, event: 'APPROVE', worth: [], blocking: [] };
  const entriesFor = (o: { thread: OpenBotThread; nodeId: string }): ThreadTriage[] => triage.filter((e) => e.threadId === o.thread.id || e.threadId === o.nodeId);
  const untriaged = open.filter((o) => entriesFor(o).length === 0).map((o) => o.thread);
  if (untriaged.length > 0) {
    const list = untriaged.slice(0, SHOWN).map(whereOf).join('; ');
    return refuse('untriaged', `${untriaged.length} open bot thread${untriaged.length === 1 ? ' has' : 's have'} not been triaged by the review (${list}${untriaged.length > SHOWN ? `; and ${untriaged.length - SHOWN} more` : ''}), so an approval is not posted. Have the review triage ${untriaged.length === 1 ? 'it' : 'them'}, or post this as a comment.`, untriaged);
  }
  const worth: WorthThread[] = [];
  const blocking: OpenBotThread[] = [];
  for (const o of open) {
    // Two entries can name one thread (its root id and its node id): the most cautious reading wins, so a blocking entry is never hidden behind another.
    const es = entriesFor(o);
    const w = es.find((e) => e.worthAddressing);
    if (w) worth.push({ ...o.thread, reason: (es.find((e) => e.severity === 'blocking') ?? w).reason });
    if (es.some((e) => e.severity === 'blocking')) blocking.push(o.thread);
  }
  return { ok: true, event: blocking.length > 0 ? 'COMMENT' : 'APPROVE', worth, blocking };
}
