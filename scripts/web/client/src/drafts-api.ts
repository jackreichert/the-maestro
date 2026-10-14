/** The page's calls for the draft queue: read it, and the three decisions through the shared token handshake (write-token.ts). Outcomes are data; nothing throws. */
import { sanitizeDrafts } from './drafts-model.ts';
import type { DraftsData } from './drafts-model.ts';
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export type DraftOp = 'approve' | 'edit' | 'reject';
export type DraftOutcome = { ok: true; url?: string } | { ok: false; message: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The queue, or null when the server has none to give. No fixture stands in: an invented draft could be approved. */
export async function loadDrafts(fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<DraftsData | null> {
  try {
    const res = await fetchFn('/api/drafts', { headers: { accept: 'application/json' } });
    return res.ok ? sanitizeDrafts(await res.json())?.data ?? null : null;
  } catch { return null; }
}

/** Sends one decision. `payload` is `{ id, text }` for approve and edit, `{ id, reason }` for reject. */
export function createDraftActions(fetchFn: Fetch = (u, i) => fetch(u, i)): { send(op: DraftOp, payload: Record<string, string>): Promise<DraftOutcome> } {
  const poster = createPoster(fetchFn);
  return {
    async send(op, payload) {
      try {
        const res = await poster.post(`/api/drafts/${op}`, payload);
        if (!res) return { ok: false, message: 'Could not get permission to save from the server. Reload the page.' };
        const body: unknown = await res.json().catch(() => null);
        if (res.ok && isObj(body) && body.ok === true) return { ok: true, ...(typeof body.url === 'string' ? { url: body.url } : {}) };
        return { ok: false, message: isObj(body) && typeof body.message === 'string' && body.message ? body.message : 'That did not go through. Nothing was posted.' };
      } catch { return { ok: false, message: 'Could not reach the server. Nothing was posted.' }; }
    },
  };
}
