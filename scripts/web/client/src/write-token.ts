/**
 * The page's write calls share one handshake: a per-start token from `GET /api/edit-token`, sent as a header on every POST.
 * It is fetched on first use, kept in memory only, and fetched again once if the server answers 403 (it was restarted, so the old
 * token is dead). `post` returns the response, or null when no token could be had; it throws only when the network does.
 */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_HEADER = 'x-podium-token';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createPoster(fetchFn: Fetch): { post(path: string, body: unknown): Promise<Response | null> } {
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

  const send = (path: string, body: unknown, tok: string): Promise<Response> =>
    fetchFn(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', [TOKEN_HEADER]: tok }, body: JSON.stringify(body) });

  async function post(path: string, body: unknown): Promise<Response | null> {
    const tok = await getToken();
    if (!tok) return null;
    const res = await send(path, body, tok);
    if (res.status !== 403) return res;
    token = null;
    const fresh = await getToken();
    return fresh ? send(path, body, fresh) : null;
  }

  return { post };
}
