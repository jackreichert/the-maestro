/** The Others' PRs tab's four writes (three on a row, and adding a PR by text), through the shared token handshake (write-token.ts). Outcomes are data; nothing throws. */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';
import type { OthersPrRow } from './types.ts';

export type OthersOp = 'ignore' | 'unignore' | 'review-anyway';
/** `null` is success; otherwise the words to show the person. */
export type OthersOutcome = string | null;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `ignore` and `review-anyway` pin the head sha the page drew (a stale page is refused); `unignore` names only the PR. */
export function createOthersActions(fetchFn: Fetch = (u, i) => fetch(u, i)): { send(op: OthersOp, p: Pick<OthersPrRow, 'repo' | 'number' | 'headSha'>): Promise<OthersOutcome>; add(ref: string): Promise<OthersOutcome> } {
  const poster = createPoster(fetchFn);
  /** Posts one body and reads the outcome: null on success, else the server's words (or a plain failure line). */
  async function post(path: string, body: unknown): Promise<OthersOutcome> {
    try {
      const res = await poster.post(path, body);
      if (!res) return 'Could not get permission to save from the server. Reload the page.';
      const reply: unknown = await res.json().catch(() => null);
      if (res.ok && isObj(reply) && reply.ok === true) return null;
      return isObj(reply) && typeof reply.message === 'string' && reply.message ? reply.message : 'That did not go through. Nothing changed.';
    } catch { return 'Could not reach the server. Nothing changed.'; }
  }
  return {
    /** Puts a PR on the list from text (owner/repo#number or its GitHub link); the server checks it. */
    add: (ref) => (ref.trim() ? post('/api/others/add', { ref: ref.trim() }) : Promise.resolve('Type a PR as owner/repo#number or paste its GitHub link.')),
    async send(op, p) {
      if (op !== 'unignore' && !p.headSha) return 'This PR has no commit recorded yet, so it cannot be pinned. Try again after the next list refresh.';
      return post(`/api/others/${op}`, op === 'unignore' ? { repo: p.repo, pr: p.number } : { repo: p.repo, pr: p.number, head: p.headSha });
    },
  };
}
