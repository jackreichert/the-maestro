/**
 * The Podium v1 gate: one check per piece of Jack's bar (useful and beautiful; each project tab a full new-engineer handover; Home with
 * charts, every project's status, links, needs-you and done). A check reads a running Podium through a `Probe` (HTTP-shaped, so it works on a
 * live server, a temp one or canned payloads) and says `pass`, `fail` (built, but short of the bar) or `not-built` (the piece is not on
 * this build yet). A check never throws: an unreadable answer is a `fail` with the reason, so a half-built Podium still gets a full report.
 */
export type Verdict = 'pass' | 'fail' | 'not-built';
export interface Result { id: string; title: string; verdict: Verdict; detail: string }
export interface Reply { status: number; text: string }
export interface Probe {
  /** GET a path on the Podium. Resolves with the status (0 when nothing answered) and the body; never rejects. */
  get(path: string): Promise<Reply>;
  /** The library page rule that flags a bare ticket id in prose: absent on this build, working, or present but not flagging. */
  plainLanguageRule(): Promise<'absent' | 'works' | 'broken'>;
}
export interface Check { id: string; title: string; run: (p: Probe) => Promise<Omit<Result, 'id' | 'title'>> }

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const out = (verdict: Verdict, detail: string): Omit<Result, 'id' | 'title'> => ({ verdict, detail });

/** The body as JSON, or null when the route is missing, errored or answered with something else. */
async function json(p: Probe, path: string): Promise<{ data: unknown } | { status: number }> {
  const r = await p.get(path);
  if (r.status !== 200) return { status: r.status };
  try { return { data: JSON.parse(r.text) as unknown }; } catch { return { status: -1 }; }
}

/** The streams the Podium knows (the `other` bucket is not a project), or the reason there are none. */
async function streamNames(p: Probe): Promise<{ names: string[] } | { why: string }> {
  const s = await json(p, '/api/state');
  if (!('data' in s) || !isObj(s.data) || !Array.isArray(s.data.streams)) return { why: `/api/state did not answer with a stream list (status ${'status' in s ? s.status : '?'})` };
  const names = s.data.streams.filter((x): x is string => typeof x === 'string' && x !== 'other');
  return names.length ? { names } : { why: 'the board has no streams, so there is no project to check' };
}

/** The display, grid, hairline, chart and status tokens arrived with the token work; the system font roles were already there, so they alone do not mean it is built. */
const NEW_TOKENS = ['--font-display', '--grid-columns', '--hairline', '--chart-grid', '--glyph-critical', '--dur-breathe'];
const TOKEN_MARKERS = [...NEW_TOKENS, '--font-sans', '--font-mono'];
const FONT_FILES = ['/fonts/geist.woff2', '/fonts/geist-mono.woff2', '/fonts/instrument-serif.woff2'];

const tokens: Check = {
  id: 'tokens', title: 'Design tokens: type, grid, hairline, chart and status, with self-hosted fonts',
  async run(p) {
    const css = await p.get('/theme.css');
    if (css.status !== 200) return out('fail', `theme.css is not served (status ${css.status})`);
    const missing = TOKEN_MARKERS.filter((m) => !css.text.includes(`${m}:`));
    if (NEW_TOKENS.every((m) => missing.includes(m))) return out('not-built', 'theme.css has none of the type, grid, hairline, chart or status tokens yet');
    if (missing.length) return out('fail', `tokens missing from theme.css: ${missing.join(', ')}`);
    const fonts = await Promise.all(FONT_FILES.map(async (f) => [f, (await p.get(f)).status] as const));
    const gone = fonts.filter(([, s]) => s !== 200).map(([f, s]) => `${f} (${s})`);
    if (gone.length) return out('fail', `fonts not served from the Podium's own origin: ${gone.join(', ')}`);
    const html = await p.get('/');
    if (/(?:href|src)=["']https?:\/\//i.test(html.text)) return out('fail', 'the page links a file off its own origin');
    return out('pass', `${TOKEN_MARKERS.length} token groups present, ${FONT_FILES.length} fonts self-hosted`);
  },
};

const home: Check = {
  id: 'home', title: 'Home: charts, a status row for every project, links, needs-you and done',
  async run(p) {
    const projects = await json(p, '/api/projects');
    if (!('data' in projects)) return projects.status === 404 ? out('not-built', 'GET /api/projects does not exist yet, so Home has no per-project status') : out('fail', `GET /api/projects answered ${projects.status}`);
    const d = projects.data;
    if (!isObj(d) || !Array.isArray(d.rows) || !Array.isArray(d.links) || !Array.isArray(d.weeks)) return out('fail', '/api/projects lacks rows, links or weeks');
    const streams = await streamNames(p);
    if ('why' in streams) return out('fail', streams.why);
    const have = new Set(d.rows.map((r) => (isObj(r) ? r.stream : undefined)));
    const absent = streams.names.filter((n) => !have.has(n));
    if (absent.length) return out('fail', `no status row for: ${absent.join(', ')}`);
    const charts = await json(p, '/api/charts');
    if (!('data' in charts) || !isObj(charts.data) || !Array.isArray(charts.data.throughput)) return out('fail', '/api/charts has no throughput series');
    const state = await json(p, '/api/state');
    const s = 'data' in state && isObj(state.data) ? state.data : {};
    if (!Array.isArray(s.asks) || !Array.isArray(s.done)) return out('fail', '/api/state lacks the asks or done lists');
    return out('pass', `${d.rows.length} project rows, ${d.links.length} links, ${d.weeks.length} weeks, ${s.asks.length} asks, ${s.done.length} done`);
  },
};

/** The stream home payload of every stream, or why one could not be read. */
async function homes(p: Probe): Promise<{ homes: [string, Json][] } | { why: string }> {
  const s = await streamNames(p);
  if ('why' in s) return s;
  const got: [string, Json][] = [];
  for (const name of s.names) {
    const h = await json(p, `/api/streams/${encodeURIComponent(name)}/home`);
    if (!('data' in h) || !isObj(h.data)) return { why: `stream ${name}: /home answered ${'status' in h ? h.status : '?'}` };
    got.push([name, h.data]);
  }
  return { homes: got };
}

const shared: Check = {
  id: 'shared-docs', title: 'Shared documents: handed-over documents listed on the project tab',
  async run(p) {
    const h = await homes(p);
    if ('why' in h) return out('fail', h.why);
    if (h.homes.every(([, d]) => !('shared' in d))) return out('not-built', 'the stream home payload has no `shared` list yet');
    const bad: string[] = [];
    for (const [name, d] of h.homes) {
      if (!Array.isArray(d.shared)) { bad.push(`${name}: shared is not a list`); continue; }
      for (const it of d.shared) {
        if (!isObj(it) || typeof it.title !== 'string' || typeof it.by !== 'string' || typeof it.date !== 'string') bad.push(`${name}: an item lacks title, by or date`);
        else if (JSON.stringify(it).includes('/Users/') || /"(?:path|url)":"\//.test(JSON.stringify(it))) bad.push(`${name}: "${it.title}" exposes an absolute path`);
      }
    }
    return bad.length ? out('fail', bad.join('; ')) : out('pass', `${h.homes.length} stream(s) list their shared documents with title, author and date, and no absolute path`);
  },
};

/** The six things a new engineer must be able to answer from one tab, and where the payload answers each. */
const HANDOVER_QUESTIONS: { q: string; answered: (h: Json) => boolean }[] = [
  { q: 'what is this project', answered: (h) => isObj(h.overview) && h.overview.state === 'ok' },
  { q: 'how do I run it locally', answered: (h) => runKind(h, 'setup') && runKind(h, 'run') },
  { q: 'how do I run its tests', answered: (h) => runKind(h, 'test') },
  { q: 'what is blocked and on whom', answered: (h) => isObj(h.blocking) && typeof h.blocking.clear === 'boolean' },
  { q: 'what was decided and where', answered: (h) => isObj(h.docs) && isObj(h.docs.decisions) && h.docs.decisions.state !== 'missing' },
  { q: 'what should I do next', answered: (h) => (isObj(h.overview) && Array.isArray(h.overview.next) && h.overview.next.length > 0) || (isObj(h.work) && Array.isArray(h.work.open) && h.work.open.length > 0) },
];
const runKind = (h: Json, kind: string): boolean => Array.isArray(h.run) && h.run.some((r) => isObj(r) && r.kind === kind && r.state === 'ok');

const handover: Check = {
  id: 'handover', title: 'Handover: every project tab answers the six new-engineer questions',
  async run(p) {
    const h = await homes(p);
    if ('why' in h) return out('fail', h.why);
    if (h.homes.every(([, d]) => !('projects' in d))) return out('not-built', 'the stream home payload has no per-project `projects` handover yet');
    const misses: string[] = [];
    let tabs = 0;
    for (const [name, d] of h.homes) {
      if (!Array.isArray(d.projects) || d.projects.length === 0) { misses.push(`${name}: no project handover (no project mapped to the stream)`); continue; }
      for (const proj of d.projects) {
        tabs += 1;
        if (!isObj(proj)) { misses.push(`${name}: a handover is not an object`); continue; }
        const gaps = HANDOVER_QUESTIONS.filter((x) => !x.answered(proj)).map((x) => x.q);
        if (gaps.length) misses.push(`${String(proj.project ?? name)}: cannot answer ${gaps.length} of 6 (${gaps.join('; ')})`);
      }
    }
    return misses.length ? out('fail', misses.join(' | ')) : out('pass', `${tabs} project tab(s), each answers all six questions`);
  },
};

const plain: Check = {
  id: 'plain-language', title: 'Plain-language library: pages written for a reader who does not know our ticket ids',
  async run(p) {
    const r = await p.plainLanguageRule();
    if (r === 'absent') return out('not-built', 'the library check has no plain-language rule yet');
    return r === 'works' ? out('pass', 'a bare ticket id in page prose is flagged; ids as evidence are not') : out('fail', 'the plain-language rule exists but does not flag a bare ticket id');
  },
};

export const CHECKS: readonly Check[] = [tokens, home, shared, handover, plain];

/** Run every check in order. A check that throws is reported as a failure; the others still run. */
export async function runGate(p: Probe, checks: readonly Check[] = CHECKS): Promise<Result[]> {
  const results: Result[] = [];
  for (const c of checks) {
    try { results.push({ id: c.id, title: c.title, ...(await c.run(p)) }); } catch (e) { results.push({ id: c.id, title: c.title, verdict: 'fail', detail: `the check itself failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }); }
  }
  return results;
}

/** One line per criterion, then a tally. Exit code: 0 only when every criterion passes. */
export function render(results: Result[]): { text: string; code: number } {
  const label: Record<Verdict, string> = { pass: 'PASS     ', fail: 'FAIL     ', 'not-built': 'NOT BUILT' };
  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  const lines = results.map((r) => `${label[r.verdict]}  ${r.id}: ${r.title}\n           ${r.detail}`);
  lines.push('', `Podium v1 gate: ${count('pass')} pass, ${count('fail')} fail, ${count('not-built')} not built yet, of ${results.length}`);
  return { text: lines.join('\n'), code: results.every((r) => r.verdict === 'pass') ? 0 : 1 };
}
