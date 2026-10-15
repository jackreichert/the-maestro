/**
 * The page's calls to the run endpoints (`/api/run/*`), through the shared token handshake (write-token.ts). The page sends only an id (or a script
 * name and its args) and a hash; the server re-reads the command, so what was reviewed is what runs or the run is refused. Every outcome comes back
 * as data and nothing here throws.
 */
import { createPoster } from './write-token.ts';
import type { Fetch } from './write-token.ts';

export type RunSource = { source: 'ask'; id: string } | { source: 'script'; name: string; args?: Record<string, string | number | boolean> };
export interface Refusal { rule: string; message: string; line?: number }
export interface Preview { source: string; target: string; title: string; command: string; sha256: string; readOnly: boolean | null; tier: string | null; runnable: boolean; refusals: Refusal[] }
export interface Chunk { seq: number; stream: 'out' | 'err'; text: string }
export interface Progress { status: 'running' | 'done' | 'failed' | 'killed' | 'timeout'; exitCode: number | null; durationMs: number | null; chunks: Chunk[]; next: number; truncated: boolean }
export interface ArgSpec { name: string; type: 'string' | 'integer' | 'enum' | 'boolean'; flag?: string; required?: boolean; default?: string | number | boolean; values?: string[]; min?: number; max?: number; description?: string }
export interface ScriptInfo { id: string; name: string; description: string; group: string; args: ArgSpec[]; readOnly: boolean; tier: string; timeoutSeconds: number }
export interface CatalogView { scripts: ScriptInfo[]; problems: string[] }
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; message: string; preview?: Preview };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FAILED = 'The server did not answer. Try again.';

export function createRunApi(fetchFn: Fetch = (url, init) => fetch(url, init)) {
  const poster = createPoster(fetchFn);

  async function call<T>(path: string, body: unknown, pick: (b: Record<string, unknown>) => T | null): Promise<Outcome<T>> {
    try {
      const res = await poster.post(path, body);
      if (!res) return { ok: false, error: 'token', message: 'Could not get permission from the server. Reload the page.' };
      const json: unknown = await res.json().catch(() => null);
      if (res.ok && isObj(json)) { const value = pick(json); if (value !== null) return { ok: true, value }; }
      const err = isObj(json) && typeof json.error === 'string' ? json.error : 'failed';
      return { ok: false, error: err, message: isObj(json) && typeof json.message === 'string' && json.message ? json.message : FAILED, ...(isObj(json) && typeof json.command === 'string' ? { preview: json as unknown as Preview } : {}) };
    } catch {
      return { ok: false, error: 'network', message: `Could not reach the server. ${FAILED}` };
    }
  }

  const asPreview = (b: Record<string, unknown>): Preview | null => (typeof b.command === 'string' && typeof b.sha256 === 'string' && Array.isArray(b.refusals) ? (b as unknown as Preview) : null);
  const asProgress = (b: Record<string, unknown>): Progress | null => (typeof b.status === 'string' && Array.isArray(b.chunks) && typeof b.next === 'number' ? (b as unknown as Progress) : null);

  return {
    catalog: (): Promise<Outcome<CatalogView>> => call('/api/run/catalog', {}, (b) => (Array.isArray(b.scripts) && Array.isArray(b.problems) ? (b as unknown as CatalogView) : null)),
    preview: (src: RunSource): Promise<Outcome<Preview>> => call('/api/run/preview', src, asPreview),
    start: (src: RunSource, sha256: string, confirm = false): Promise<Outcome<string>> => call('/api/run/start', { ...src, sha256, ...(confirm ? { confirm: true } : {}) }, (b) => (typeof b.runId === 'string' ? b.runId : null)),
    poll: (runId: string, since: number): Promise<Outcome<Progress>> => call('/api/run/poll', { runId, since }, asProgress),
    kill: (runId: string): Promise<Outcome<true>> => call('/api/run/kill', { runId }, (b) => (b.ok === true ? true : null)),
    resolve: (runId: string): Promise<Outcome<{ id: string; answer: string }>> => call('/api/run/resolve', { runId }, (b) => (typeof b.id === 'string' && typeof b.answer === 'string' ? { id: b.id, answer: b.answer } : null)),
  };
}

export type RunApi = ReturnType<typeof createRunApi>;
