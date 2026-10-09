/**
 * The page's call that answers an ask: `POST /api/asks/answer`, through the shared token handshake (write-token.ts).
 * Every outcome comes back as data, a saved answer or a message to show; nothing here throws. The server decides what text a
 * recommendation or a skip is recorded as and returns it, so what the page shows as saved is what the ledger holds.
 */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export type AnswerRequest =
  | { id: string; mode: 'text'; answer: string }
  | { id: string; mode: 'recommend' }
  | { id: string; mode: 'skip' };

export type AnswerOutcome =
  | { ok: true; answer: string }
  | { ok: false; message: string; /** The ask is gone or closed: nothing to retry; the board will drop it. */ closed: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const GENERIC_FAILURE = 'The answer was not saved. Try again.';

/** An answerer over `fetchFn` (the page's own `fetch` by default). */
export function createAnswerer(fetchFn: Fetch = (url, init) => fetch(url, init)): { send(req: AnswerRequest): Promise<AnswerOutcome> } {
  const poster = createPoster(fetchFn);

  async function send(req: AnswerRequest): Promise<AnswerOutcome> {
    try {
      const res = await poster.post('/api/asks/answer', req);
      if (!res) return { ok: false, message: 'Could not get permission to save from the server. Reload the page.', closed: false };
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && isObj(body) && body.ok === true && typeof body.answer === 'string') return { ok: true, answer: body.answer };
      const message = isObj(body) && typeof body.message === 'string' && body.message ? body.message : GENERIC_FAILURE;
      return { ok: false, message, closed: isObj(body) && (body.error === 'answered' || body.error === 'unknown') };
    } catch {
      return { ok: false, message: `Could not reach the server. ${GENERIC_FAILURE}`, closed: false };
    }
  }

  return { send };
}

/** Whether the card offers Skip: only a two-way ask; one with no door recorded counts as one-way, and the server refuses a skip of it too. */
export const canSkip = (a: { door?: 'one-way' | 'two-way' }): boolean => a.door === 'two-way';
