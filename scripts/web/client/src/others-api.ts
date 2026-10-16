/** The Others' PRs tab's three writes, through the shared token handshake (write-token.ts). Outcomes are data; nothing throws. */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';
import type { OthersPrRow } from './types.ts';

export type OthersOp = 'ignore' | 'unignore' | 'review-anyway';
/** `null` is success; otherwise the words to show the person. */
export type OthersOutcome = string | null;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `ignore` and `review-anyway` pin the head sha the page drew (a stale page is refused); `unignore` names only the PR. */
export function createOthersActions(fetchFn: Fetch = (u, i) => fetch(u, i)): { send(op: OthersOp, p: Pick<OthersPrRow, 'repo' | 'number' | 'headSha'>): Promise<OthersOutcome> } {
  const poster = createPoster(fetchFn);
  return {
    async send(op, p) {
      if (op !== 'unignore' && !p.headSha) return 'This PR has no commit recorded yet, so it cannot be pinned. Try again after the next list refresh.';
      try {
        const res = await poster.post(`/api/others/${op}`, op === 'unignore' ? { repo: p.repo, pr: p.number } : { repo: p.repo, pr: p.number, head: p.headSha });
        if (!res) return 'Could not get permission to save from the server. Reload the page.';
        const body: unknown = await res.json().catch(() => null);
        if (res.ok && isObj(body) && body.ok === true) return null;
        return isObj(body) && typeof body.message === 'string' && body.message ? body.message : 'That did not go through. Nothing changed.';
      } catch { return 'Could not reach the server. Nothing changed.'; }
    },
  };
}
