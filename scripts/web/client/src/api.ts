import { sanitizeCharts, sanitizeCost, sanitizeEpics, sanitizeHome, sanitizeLocalReview, sanitizeOpenPrs, sanitizeOthersPrs, sanitizeProjects, sanitizeRefreshStatus, sanitizeStandup, sanitizeState } from './contract.ts';
import { configureTrustedTenants } from './link-policy.ts';
import { configureSeries } from './series.ts';
import type { ChartsData, CostData, EpicsData, LocalReview, OpenPrsData, OthersPrsData, PodiumState, PrsRefreshStatus, ProjectsData, StandupData, StreamHome } from './types.ts';

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

/** Tell the series palette which streams the operator gave a fixed colour. Any failure leaves the defaults, and the rest hash to a colour. */
export async function loadSeries(): Promise<void> {
  try {
    const body = await getJson('/api/series');
    configureSeries(typeof body === 'object' && body !== null ? (body as { named?: unknown }).named : undefined);
  } catch {
    configureSeries(undefined);
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

/**
 * Home's status rows, links and weekly counts. On a live page (`live`) a failed or unusable answer throws, so Home shows its
 * "could not be loaded" state: the sample projects would pass for real ones. The bundled sample stands in only when no server answers.
 */
export async function loadProjects(live: boolean): Promise<Loaded<ProjectsData>> {
  if (!live) return loadWithFallback('/api/projects', '/fixtures/projects.json', sanitizeProjects);
  const got = sanitizeProjects(await getJson('/api/projects'));
  if (!got) throw new Error('/api/projects does not match the contract');
  return { ...got, source: 'server' };
}

export const loadCharts = (): Promise<Loaded<ChartsData>> => loadWithFallback('/api/charts?days=14', '/fixtures/charts.json', (x) => {
  return sanitizeCharts(x);
});

/**
 * One stream's home base, or null when the server has none to give (sample data, an unknown stream, an unusable body).
 * No fixture stands in: a tab without a home base is a complete tab, and an invented epic would be worse than none.
 */
export async function loadHome(stream: string): Promise<Loaded<StreamHome> | null> {
  try {
    const got = sanitizeHome(await getJson(`/api/streams/${encodeURIComponent(stream)}/home`));
    return got && { data: got.home, source: 'server', dropped: got.dropped };
  } catch {
    return null;
  }
}

/** Every stream's open epics, or null when the server has none to give. No fixture stands in: a page without epic lines is complete. */
export async function loadEpics(): Promise<EpicsData | null> {
  try {
    return sanitizeEpics(await getJson('/api/epics'))?.data ?? null;
  } catch {
    return null;
  }
}

/** The cost widget's data, or null when the server has none to give (sample data, an old server, an unusable body). No fixture stands in. */
export async function loadCost(): Promise<CostData | null> {
  try {
    return sanitizeCost(await getJson('/api/cost'))?.data ?? null;
  } catch {
    return null;
  }
}

/** The standup text for `days` whole days back (the server's default window when omitted). Throws when the server refuses, is unreachable or answers with something unusable, so the widget can say so. */
export async function loadStandup(days?: number): Promise<StandupData> {
  const data = sanitizeStandup(await getJson(days === undefined ? '/api/standup' : `/api/standup?days=${encodeURIComponent(String(days))}`));
  if (!data) throw new Error('the standup answer was not usable');
  return data;
}

/** The local review queue, or null when the server has none to give (sample data, an old server, an unusable body). */
export async function loadLocalReview(): Promise<LocalReview | null> {
  try {
    return sanitizeLocalReview(await getJson('/api/local-review'))?.data ?? null;
  } catch {
    return null;
  }
}

/** Every open PR grouped by repo, or null when the server has none to give (sample data, an old server, an unusable body). No fixture stands in. */
export async function loadOpenPrs(): Promise<OpenPrsData | null> {
  try {
    return sanitizeOpenPrs(await getJson('/api/prs'))?.data ?? null;
  } catch {
    return null;
  }
}

/** Every open teammate PR, or null when the server has none to give. No fixture stands in. */
export async function loadOthersPrs(): Promise<OthersPrsData | null> {
  try {
    return sanitizeOthersPrs(await getJson('/api/others-prs'))?.data ?? null;
  } catch {
    return null;
  }
}

/** Where the PR refresh stands, or null when the server cannot say. */
export async function loadRefreshStatus(): Promise<PrsRefreshStatus | null> {
  try {
    return sanitizeRefreshStatus(await getJson('/api/prs/refresh-state'));
  } catch {
    return null;
  }
}
