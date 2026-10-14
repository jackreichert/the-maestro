/**
 * The review threads on the person's own PR that are waiting for an answer, read from GitHub (read-only: one GraphQL query through `gh`).
 * A thread waits when it is unresolved and the last word is someone else's. A thread is a BOT thread only when every participant other than
 * the person is a bot (lib/github-bots.ts); one human anywhere in it makes it a human thread, which is only ever queued for approval.
 */
import { isBotAuthor } from '../github-bots.ts';
import type { GhRun } from '../drafts/post.ts';

export interface ThreadComment { id: number; author: string; bot: boolean; body: string }
export interface Thread {
  /** GraphQL node id, needed to resolve the thread. */
  nodeId: string;
  /** The first comment's id: the one a reply is posted against. */
  rootId: number;
  path: string; line: number | null; outdated: boolean;
  comments: ThreadComment[];
  /** The last comment that is not the person's, or null when the person spoke last. */
  waitingOn: ThreadComment | null;
  /** 'bot' only when every participant besides the person is a bot. */
  kind: 'bot' | 'human';
}
export interface PrThreads { author: string; open: boolean; threads: Thread[] }

const QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state author{login} reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line comments(first:50){nodes{databaseId body author{login __typename}}}}}}}}';

interface RawComment { databaseId?: number; body?: string; author?: { login?: string; __typename?: string } | null }
interface RawThread { id?: string; isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null; comments?: { nodes?: RawComment[] } }

/** Reads the unresolved threads that wait on `self`. Throws when GitHub cannot be read or the PR has more threads than one page holds. */
export function fetchThreads(repo: string, pr: number, self: string, run: GhRun): PrThreads {
  const [owner, name] = repo.split('/');
  if (!owner || !name || !Number.isSafeInteger(pr) || pr <= 0) throw new Error('bad repo or PR number');
  const r = run(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]);
  if (r.status !== 0) throw new Error(`gh could not read the threads: ${(r.stderr.split('\n')[0] ?? '').slice(0, 200)}`);
  const pull = (JSON.parse(r.stdout) as { data?: { repository?: { pullRequest?: { state?: string; author?: { login?: string }; reviewThreads?: { pageInfo?: { hasNextPage?: boolean }; nodes?: RawThread[] } } } } }).data?.repository?.pullRequest;
  if (!pull) throw new Error('no such PR');
  if (pull.reviewThreads?.pageInfo?.hasNextPage) throw new Error('too many review threads to read in one page');
  const me = self.toLowerCase();
  const threads: Thread[] = [];
  for (const t of pull.reviewThreads?.nodes ?? []) {
    if (t.isResolved || typeof t.id !== 'string') continue;
    const comments: ThreadComment[] = (t.comments?.nodes ?? []).filter((c) => Number.isSafeInteger(c.databaseId)).map((c) => ({ id: c.databaseId as number, author: c.author?.login ?? '', bot: isBotAuthor(c.author), body: (c.body ?? '').slice(0, 2000) }));
    const root = comments[0];
    if (!root) continue;
    const others = comments.filter((c) => c.author.toLowerCase() !== me);
    const last = comments[comments.length - 1] as ThreadComment;
    const waitingOn = last.author.toLowerCase() === me ? null : last;
    threads.push({ nodeId: t.id, rootId: root.id, path: t.path ?? '', line: typeof t.line === 'number' ? t.line : null, outdated: !!t.isOutdated, comments, waitingOn, kind: others.length > 0 && others.every((c) => c.bot) ? 'bot' : 'human' });
  }
  return { author: pull.author?.login ?? '', open: pull.state === 'OPEN', threads };
}

/** The threads that need an answer from the person. */
export const waitingThreads = (p: PrThreads): Thread[] => p.threads.filter((t) => t.waitingOn !== null);
