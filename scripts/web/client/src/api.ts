import { sanitizeCharts, sanitizeState } from './contract.ts';
import { configureTrustedTenants } from './link-policy.ts';
import type { ChartsData, PodiumState } from './types.ts';

export type Source = 'server' | 'fixture';

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Tell the link policy which Atlassian tenants the server was configured to trust. Any failure leaves the list empty, which is the safe default. */
export async function loadLinkHosts(): Promise<void> {
  try {
    const body = await getJson('/api/link-hosts');
    configureTrustedTenants(typeof body === 'object' && body !== null ? (body as { atlassian?: unknown }).atlassian : undefined);
  } catch {
    configureTrustedTenants([]);
  }
}

/** What the header says about where the page's data came from: Live only when both endpoints are, else which ones are sample data. */
export function describeSources(state: Source, charts: Source, dropped: number, generatedAt: string): string {
  const sample = [state === 'fixture' ? 'state' : '', charts === 'fixture' ? 'charts' : ''].filter(Boolean);
  const base = sample.length === 0 ? `Live. Updated ${generatedAt}.` : `Showing bundled sample data for ${sample.join(' and ')}: no server answered.`;
  return dropped > 0 ? `${base} ${dropped} malformed ${dropped === 1 ? 'row was' : 'rows were'} skipped.` : base;
}

export interface Loaded<T> { data: T; source: Source; dropped: number }

/** Ask the server; when nothing answers (or it answers with an unusable shape) load the bundled fixture instead. */
async function loadWithFallback<T>(api: string, fixture: string, clean: (x: unknown) => { data: T; dropped: number } | null): Promise<Loaded<T>> {
  try {
    const got = clean(await getJson(api));
    if (got) return { ...got, source: 'server' };
  } catch {
    // no server yet: fall through to the fixture
  }
  const got = clean(await getJson(fixture));
  if (!got) throw new Error(`${fixture} does not match the contract`);
  return { ...got, source: 'fixture' };
}

export const loadState = (): Promise<Loaded<PodiumState>> => loadWithFallback('/api/state', '/fixtures/state.json', (x) => {
  const got = sanitizeState(x);
  return got && { data: got.state, dropped: got.dropped };
});

export const loadCharts = (): Promise<Loaded<ChartsData>> => loadWithFallback('/api/charts?days=14', '/fixtures/charts.json', (x) => {
  return sanitizeCharts(x);
});
