/**
 * The page's call that comments on a blocked item, and optionally unblocks it: `POST /api/blocked/comment`, through the shared token
 * handshake (write-token.ts). Every outcome comes back as data, a saved comment or a message to show; nothing here throws. The server
 * returns the comment as it recorded it (whitespace squashed), so what the page shows as saved is what the ledger holds.
 */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export type CommentRequest = { id: string; mode: 'unblock' | 'comment'; comment: string };

export type CommentOutcome =
  | { ok: true; comment: string; /** The same comment was already recorded: nothing new was written. */ same: boolean; /** On an unblock, the id of the queued item. */ queued?: string }
  | { ok: false; message: string; /** The item is gone or no longer blocked: nothing to retry; the board will drop it. */ closed: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const GENERIC_FAILURE = 'The comment was not saved. Try again.';

/** A commenter over `fetchFn` (the page's own `fetch` by default). */
export function createCommenter(fetchFn: Fetch = (url, init) => fetch(url, init)): { send(req: CommentRequest): Promise<CommentOutcome> } {
  const poster = createPoster(fetchFn);

  async function send(req: CommentRequest): Promise<CommentOutcome> {
    try {
      const res = await poster.post('/api/blocked/comment', req);
      if (!res) return { ok: false, message: 'Could not get permission to save from the server. Reload the page.', closed: false };
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && isObj(body) && body.ok === true && typeof body.comment === 'string') {
        return { ok: true, comment: body.comment, same: body.same === true, ...(typeof body.queued === 'string' ? { queued: body.queued } : {}) };
      }
      const message = isObj(body) && typeof body.message === 'string' && body.message ? body.message : GENERIC_FAILURE;
      return { ok: false, message, closed: isObj(body) && (body.error === 'unblocked' || body.error === 'unknown') };
    } catch {
      return { ok: false, message: `Could not reach the server. ${GENERIC_FAILURE}`, closed: false };
    }
  }

  return { send };
}
