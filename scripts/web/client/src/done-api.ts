/**
 * The page's two calls for editing a stream's definition of done: `GET /api/streams/<name>/done-text` (the section as written, with a
 * revision) and `POST /api/done/save`, through the shared token handshake (write-token.ts). Every outcome comes back as data, a value or a
 * message to show; nothing here throws. The page names a stream and a source (kind and name), never a path.
 */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export type DoneKind = 'epic' | 'project' | 'new';
export interface DoneRef { stream: string; kind: DoneKind; name: string }
export type LoadOutcome = { ok: true; text: string; rev: string } | { ok: false; message: string };
export type SaveOutcome = { ok: true; rev: string } | { ok: false; message: string; /** The note changed under the editor: reloading is the only way on. */ changed: boolean };
export interface DoneApi { load(ref: DoneRef): Promise<LoadOutcome>; save(ref: DoneRef, rev: string, text: string): Promise<SaveOutcome> }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const LOAD_FAILURE = 'Could not open this definition to edit. Reload the page and try again.';
export const SAVE_FAILURE = 'It was not saved. Your text is still here; try again.';

/** The calls over `fetchFn` (the page's own `fetch` by default). */
export function createDoneApi(fetchFn: Fetch = (url, init) => fetch(url, init)): DoneApi {
  const poster = createPoster(fetchFn);

  async function load(ref: DoneRef): Promise<LoadOutcome> {
    try {
      const q = new URLSearchParams({ kind: ref.kind, name: ref.kind === 'new' ? '' : ref.name });
      const res = await fetchFn(`/api/streams/${encodeURIComponent(ref.stream)}/done-text?${q}`, { headers: { accept: 'application/json' } });
      const body: unknown = res.ok ? await res.json().catch(() => null) : null;
      return isObj(body) && typeof body.text === 'string' && typeof body.rev === 'string' ? { ok: true, text: body.text, rev: body.rev } : { ok: false, message: LOAD_FAILURE };
    } catch { return { ok: false, message: LOAD_FAILURE }; }
  }

  async function save(ref: DoneRef, rev: string, text: string): Promise<SaveOutcome> {
    try {
      const body = { stream: ref.stream, kind: ref.kind, ...(ref.kind === 'new' ? {} : { name: ref.name }), rev, text };
      const res = await poster.post('/api/done/save', body);
      if (!res) return { ok: false, message: 'Could not get permission to save from the server. Reload the page.', changed: false };
      const out: unknown = await res.json().catch(() => null);
      if (res.ok && isObj(out) && out.ok === true && typeof out.rev === 'string') return { ok: true, rev: out.rev };
      const message = isObj(out) && typeof out.message === 'string' && out.message ? out.message : SAVE_FAILURE;
      return { ok: false, message, changed: isObj(out) && out.error === 'changed' };
    } catch {
      return { ok: false, message: `Could not reach the server. ${SAVE_FAILURE}`, changed: false };
    }
  }

  return { load, save };
}
