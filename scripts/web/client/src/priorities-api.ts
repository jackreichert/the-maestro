/**
 * The page's only calls that change anything: reorder, add and delete today's priorities.
 *
 * A write needs the per-start token the server hands out at `GET /api/edit-token`; it is fetched on first use, kept in memory
 * only, and fetched again once if the server answers 403 (it was restarted, so the old token is dead). Every outcome comes
 * back as data: `ok` with the list as the server now has it, or a message to show, with the server's list when it sent one so
 * the page can drop its optimistic guess and show the truth. Nothing here throws.
 */
import { sanitizePriorities } from './contract.ts';
import { GENERIC_FAILURE } from './priority-edit.ts';
import type { Priority } from './types.ts';

export type EditRequest =
  | { op: 'move'; from: number; to: number; text: string }
  | { op: 'add'; text: string; stream?: string }
  | { op: 'delete'; index: number; text: string };

export type EditOutcome =
  | { ok: true; items: Priority[]; max?: number }
  | { ok: false; message: string; items?: Priority[]; max?: number };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const TOKEN_HEADER = 'x-podium-token';

/** The server's list from an answer body: its items (empty unless there is a list for today) and the cap. */
function listOf(body: unknown): { items: Priority[]; max?: number } | null {
  if (!isObj(body) || !('priorities' in body)) return null;
  const { value } = sanitizePriorities(body.priorities);
  const max = typeof body.max === 'number' && Number.isInteger(body.max) && body.max >= 1 ? body.max : undefined;
  return { items: value.state === 'ok' ? value.items : [], ...(max === undefined ? {} : { max }) };
}

/** An editor over `fetchFn` (the page's own `fetch` by default). The token is held inside it. */
export function createEditor(fetchFn: Fetch = (url, init) => fetch(url, init)): { send(req: EditRequest): Promise<EditOutcome> } {
  let token: string | null = null;

  async function getToken(): Promise<string | null> {
    if (token) return token;
    try {
      const res = await fetchFn('/api/edit-token', { headers: { accept: 'application/json' } });
      const body: unknown = res.ok ? await res.json() : null;
      token = isObj(body) && typeof body.token === 'string' ? body.token : null;
    } catch { token = null; }
    return token;
  }

  async function post(req: EditRequest, tok: string): Promise<Response> {
    const { op, ...body } = req;
    return fetchFn(`/api/priorities/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', [TOKEN_HEADER]: tok }, body: JSON.stringify(body) });
  }

  async function send(req: EditRequest): Promise<EditOutcome> {
    try {
      let tok = await getToken();
      if (!tok) return { ok: false, message: 'Could not get permission to edit from the server. Reload the page.' };
      let res = await post(req, tok);
      if (res.status === 403) {   // the server restarted: its old token is dead
        token = null;
        tok = await getToken();
        if (!tok) return { ok: false, message: 'Could not get permission to edit from the server. Reload the page.' };
        res = await post(req, tok);
      }
      const body: unknown = await res.json().catch(() => null);
      const list = listOf(body);
      if (res.ok && list) return { ok: true, items: list.items, ...(list.max === undefined ? {} : { max: list.max }) };
      const message = isObj(body) && typeof body.message === 'string' && body.message ? body.message : GENERIC_FAILURE;
      return { ok: false, message, ...(list ? { items: list.items, ...(list.max === undefined ? {} : { max: list.max }) } : {}) };
    } catch {
      return { ok: false, message: `Could not reach the server. ${GENERIC_FAILURE}` };
    }
  }

  return { send };
}
