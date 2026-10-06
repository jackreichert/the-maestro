import type { ChartsData, PodiumState } from './types.ts';

export type Source = 'server' | 'fixture';

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Narrow an unknown payload to a PodiumState enough that rendering cannot throw on a missing array. */
export function isState(x: unknown): x is PodiumState {
  const o = x as Partial<PodiumState> | null;
  if (typeof o !== 'object' || o === null) return false;
  const lists = [o.streams, o.asks, o.working, o.queued, o.blocked, o.prs, o.footer];
  return lists.every(Array.isArray) && typeof o.priorities === 'object' && o.priorities !== null && typeof o.priorities.state === 'string';
}

export function isCharts(x: unknown): x is ChartsData {
  const o = x as Partial<ChartsData> | null;
  return typeof o === 'object' && o !== null && Array.isArray(o.throughput) && Array.isArray(o.ageBuckets) && typeof o.prMix === 'object' && typeof o.modelMix === 'object';
}

/** Ask the server; when nothing answers (or it answers with the wrong shape) load the bundled fixture instead. */
async function loadWithFallback<T>(api: string, fixture: string, ok: (x: unknown) => x is T): Promise<{ data: T; source: Source }> {
  try {
    const data = await getJson(api);
    if (ok(data)) return { data, source: 'server' };
  } catch {
    // no server yet: fall through to the fixture
  }
  const data = await getJson(fixture);
  if (!ok(data)) throw new Error(`${fixture} does not match the contract`);
  return { data, source: 'fixture' };
}

export const loadState = (): Promise<{ data: PodiumState; source: Source }> => loadWithFallback('/api/state', '/fixtures/state.json', isState);
export const loadCharts = (): Promise<{ data: ChartsData; source: Source }> => loadWithFallback('/api/charts?days=14', '/fixtures/charts.json', isCharts);
