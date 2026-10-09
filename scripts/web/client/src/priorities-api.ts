/**
 * The page's calls that change today's priorities: reorder, add and delete.
 *
 * A write needs the per-start token the server hands out (write-token.ts). Every outcome comes
 * back as data: `ok` with the list as the server now has it, or a message to show, with the server's list when it sent one so
 * the page can drop its optimistic guess and show the truth. Nothing here throws.
 */
import { sanitizePriorities } from './contract.ts';
import { GENERIC_FAILURE } from './priority-edit.ts';
import type { Priority } from './types.ts';
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export type EditRequest =
  | { op: 'move'; from: number; to: number; text: string }
  | { op: 'add'; text: string; stream?: string }
  | { op: 'delete'; index: number; text: string };

export type EditOutcome =
  | { ok: true; items: Priority[]; max?: number }
  | { ok: false; message: string; items?: Priority[]; max?: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The server's list from an answer body: its items (empty unless there is a list for today) and the cap. */
function listOf(body: unknown): { items: Priority[]; max?: number } | null {
  if (!isObj(body) || !('priorities' in body)) return null;
  const { value } = sanitizePriorities(body.priorities);
  const max = typeof body.max === 'number' && Number.isInteger(body.max) && body.max >= 1 ? body.max : undefined;
  return { items: value.state === 'ok' ? value.items : [], ...(max === undefined ? {} : { max }) };
}

/** An editor over `fetchFn` (the page's own `fetch` by default). The token is held inside it. */
export function createEditor(fetchFn: Fetch = (url, init) => fetch(url, init)): { send(req: EditRequest): Promise<EditOutcome> } {
  const poster = createPoster(fetchFn);
  const NO_PERMISSION = { ok: false, message: 'Could not get permission to edit from the server. Reload the page.' } as const;

  async function send(req: EditRequest): Promise<EditOutcome> {
    try {
      const { op, ...rest } = req;
      const res = await poster.post(`/api/priorities/${op}`, rest);
      if (!res) return NO_PERMISSION;
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
