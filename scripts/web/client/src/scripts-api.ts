/**
 * The page's calls for the registered scripts: read them (`GET /api/scripts`) and mark one as run (`POST /api/scripts/ran`, through the shared token
 * handshake). The page sends only a script id; the server decides whether the mark is allowed and what the ask is closed with. Outcomes are data.
 */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export interface LastRun { at: string; result: string; via: string }
export interface ScriptRow {
  id: string; kind: 'one-time' | 'reusable'; title: string; what: string; why: string; after: string; blocks: string; blockedBy?: string; command: string;
  createdAt: string; ask: string; status: 'blocked' | 'reusable' | 'history'; askOpen: boolean; runs: number; lastRun?: LastRun;
}
/** One file behind a script's command, as the server's source route describes it. `text` is absent when the file is not shown, and `hidden` says why. */
export interface SourceRow {
  path: string; role: 'script' | 'include'; lines: number; mutates: number; gates: number; warn: boolean; modified?: string; hidden?: string;
  text?: string; marks: Record<number, 'mutates' | 'gate'>;
}
export type MarkOutcome = { ok: true; resolvedAsk: boolean } | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** One row if it has every field the page reads, else null: a row the page cannot read is left out, never half drawn. */
export function sanitizeScript(v: unknown): ScriptRow | null {
  if (!isObj(v)) return null;
  const { id, kind, title, what, why, after, blocks, blockedBy, command, createdAt, ask, status, askOpen, runs, lastRun } = v;
  if (![id, title, what, why, after, blocks, command, createdAt, ask].every(isStr)) return null;
  if (kind !== 'one-time' && kind !== 'reusable') return null;
  if (status !== 'blocked' && status !== 'reusable' && status !== 'history') return null;
  if (typeof askOpen !== 'boolean' || typeof runs !== 'number') return null;
  const last = isObj(lastRun) && isStr(lastRun.at) && isStr(lastRun.result) && isStr(lastRun.via) ? { at: lastRun.at, result: lastRun.result, via: lastRun.via } : undefined;
  return { id: id as string, kind, title: title as string, what: what as string, why: why as string, after: after as string, blocks: blocks as string, ...(isStr(blockedBy) ? { blockedBy } : {}), command: command as string, createdAt: createdAt as string, ask: ask as string, status, askOpen, runs, ...(last ? { lastRun: last } : {}) };
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** One source file if it has every field the page reads, else null. Marks keep only line numbers with a known kind. */
export function sanitizeSource(v: unknown): SourceRow | null {
  if (!isObj(v)) return null;
  const { path, role, lines, mutates, gates, warn, modified, hidden, text, marks } = v;
  if (!isStr(path) || (role !== 'script' && role !== 'include') || !count(lines) || !count(mutates) || !count(gates) || typeof warn !== 'boolean') return null;
  const kept: SourceRow['marks'] = {};
  if (isObj(marks)) for (const [k, kind] of Object.entries(marks)) if (/^\d+$/.test(k) && (kind === 'mutates' || kind === 'gate')) kept[Number(k)] = kind;
  return { path, role, lines, mutates, gates, warn, marks: kept, ...(isStr(modified) ? { modified } : {}), ...(isStr(hidden) ? { hidden } : {}), ...(isStr(text) ? { text } : {}) };
}

/** The source files behind one script's command (`GET /api/scripts/<id>/source`), or null when the server has none to give. */
export async function loadScriptSource(id: string, fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<SourceRow[] | null> {
  try {
    const res = await fetchFn(`/api/scripts/${encodeURIComponent(id)}/source`, { headers: { accept: 'application/json' } });
    const body: unknown = res.ok ? await res.json() : null;
    return isObj(body) && Array.isArray(body.files) ? body.files.flatMap((f) => sanitizeSource(f) ?? []) : null;
  } catch { return null; }
}

/** The registered scripts, or null when the server has none to give. */
export async function loadScripts(fetchFn: Fetch = (u, i) => fetch(u, i)): Promise<ScriptRow[] | null> {
  try {
    const res = await fetchFn('/api/scripts', { headers: { accept: 'application/json' } });
    const body: unknown = res.ok ? await res.json() : null;
    return isObj(body) && Array.isArray(body.scripts) ? body.scripts.flatMap((s) => sanitizeScript(s) ?? []) : null;
  } catch { return null; }
}

export function createScriptActions(fetchFn: Fetch = (u, i) => fetch(u, i)): { markRan(id: string): Promise<MarkOutcome> } {
  const poster = createPoster(fetchFn);
  return {
    async markRan(id) {
      try {
        const res = await poster.post('/api/scripts/ran', { id });
        if (!res) return { ok: false, message: 'Could not get permission to save from the server. Reload the page.' };
        const body: unknown = await res.json().catch(() => null);
        if (res.ok && isObj(body) && body.ok === true) return { ok: true, resolvedAsk: body.resolvedAsk === true };
        return { ok: false, message: isObj(body) && isStr(body.message) && body.message ? body.message : 'That did not go through. Nothing was recorded.' };
      } catch { return { ok: false, message: 'Could not reach the server. Nothing was recorded.' }; }
    },
  };
}
export type ScriptActions = ReturnType<typeof createScriptActions>;
