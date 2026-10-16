#!/usr/bin/env node
/**
 * REVIEW-MISS HARVEST: what reviewers found that the author's own review missed, kept as evidence for mithril and for the planning checklist.
 *
 *   node scripts/review-harvest.ts harvest <owner/repo#N>... | --since YYYY-MM-DD [--jack <login>] [--store <dir>] [--skills <dir>] [--json]
 *   node scripts/review-harvest.ts pending [--store <dir>] [--skills <dir>] [--json]
 *   node scripts/review-harvest.ts triage <id> --class mithril|planning|dropped --real yes|no [--fate F] [--why W] [--coverage covered|partial|not-covered]
 *                                           [--skill S] [--cite C|unsourced] [--category K] [--candidate TEXT] [--store <dir>]
 *   node scripts/review-harvest.ts batch [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--out <dir>] [--write] [--store <dir>]
 *
 * `harvest` is read-only against GitHub (`gh api graphql`: review threads, review bodies, issue comments, changed files). Only PRs authored
 * by `--jack` (default `gh_login`) are read; comments by that login are skipped, and his replies are read only to hint each thread's fate and
 * are never stored. Findings are code-level gists: fences, links and addresses removed, and a PHI or secret shape withholds the text. Twin PRs and
 * repeat passes collapse into one finding (lib/review-harvest.ts). Re-harvesting a PR changes nothing. `--since` finds Jack's merged PRs by search.
 * `pending` lists findings with no triage yet, with the skill lines that share the most words (a coverage hint). `triage` records one verdict, the
 * playbook's judgement step. `batch` renders the weekly note; it writes only with `--write` (and not while any finding in the window is untriaged), and it never edits a mithril skill.
 * Exit 0 ok, 2 on usage, an unreadable PR, or a PR with more than 100 threads, reviews or comments (read in part, reported, not marked harvested).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_PROJECT, GH_LOGIN, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { searchAllPages } from './lib/gh-search.ts';
import { toolCommand } from './lib/tool-bin.ts';
import { printJson } from './lib/json-out.ts';
import { parseArgs } from './lib/journal/args.ts';
import { candidateStatus, coverageHints, dropReason, itemsFrom, mergeItems, type Finding, type PrNode, type Triage } from './lib/review-harvest.ts';

const REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN = /^[\w-]+(\[bot\])?$/;
const CLASSES = ['mithril', 'planning', 'dropped'];
const COVERAGE = ['covered', 'partial', 'not-covered'];
const FATES = ['fixed', 'deferred', 'declined', 'resolved', 'open'];
const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
author{login} headRefName files(first:100){pageInfo{hasNextPage} nodes{path}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved path comments(first:20){nodes{id body author{login}}}}}
reviews(first:100){pageInfo{hasNextPage} nodes{id body author{login}}}
comments(first:100){pageInfo{hasNextPage} nodes{id body author{login}}}
}}}`;

interface Store { findings: Finding[]; harvested: Record<string, string> }
const today = (): string => new Date().toISOString().slice(0, 10);
const fail = (msg: string): never => { console.error(`review-harvest: ${msg}`); process.exit(2); };

function storeDir(flag: string | null): string {
  if (flag) return flag;
  if (!LEDGER_ROOT) return fail('pass --store <dir> (or set LEDGER_ROOT)');
  return join(LEDGER_ROOT, 'Projects', CONTAINER_PROJECT, 'ReviewHarvest');
}

function loadStore(dir: string): Store {
  const file = join(dir, 'store.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Store : { findings: [], harvested: {} };
}

function saveStore(dir: string, store: Store): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `store.json.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(store, null, 1));
  renameSync(tmp, join(dir, 'store.json'));
}

/** The last triage record per finding id; a later line replaces an earlier one. */
export function loadTriage(dir: string): Map<string, Triage> {
  const file = join(dir, 'triage.jsonl');
  const out = new Map<string, Triage>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try { const t = JSON.parse(line) as Triage; if (t.id) out.set(t.id, t); } catch { /* a torn line is skipped, not fatal */ }
  }
  return out;
}

function fetchPr(ref: string): PrNode {
  const [, repo, num] = REF.exec(ref)!;
  const [owner, name] = repo!.split('/');
  const r = spawnSync(...toolCommand('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${num}`]), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || 'gh failed').trim().split('\n')[0]);
  const parsed = JSON.parse(r.stdout) as { errors?: { message?: string }[]; data?: { repository?: { pullRequest?: PrNode } } };
  const pr = parsed.data?.repository?.pullRequest;
  if (parsed.errors?.length || !pr) throw new Error(parsed.errors?.[0]?.message ?? 'pull request not found');
  return pr;
}

/** Which connections of a PR have more than the 100 nodes read, so the harvest says what it did not see. */
export const truncatedParts = (pr: PrNode): string[] =>
  (['reviewThreads', 'reviews', 'comments'] as const).filter((k) => (pr[k] as { pageInfo?: { hasNextPage?: boolean } } | undefined)?.pageInfo?.hasNextPage);

function mergedSince(jack: string, since: string): string[] {
  if (!DATE.test(since)) return fail('--since needs YYYY-MM-DD');
  const q = `query($after:String){search(query:"is:pr is:merged author:${jack} merged:>=${since}",type:ISSUE,first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number repository{nameWithOwner}}}}}`;
  return searchAllPages<{ number: number; repository: { nameWithOwner: string } }>(q).map((n) => `${n.repository.nameWithOwner}#${n.number}`);
}

function harvest(refs: string[], jack: string, dir: string): { added: number; skipped: string[]; failed: string[]; truncated: string[]; total: number } {
  const skipped: string[] = [];
  const failed: string[] = [];
  const truncated: string[] = [];
  let added = 0;
  let total = loadStore(dir).findings.length;
  for (const ref of refs) {
    try {
      const pr = fetchPr(ref);
      if ((pr.author?.login ?? '').toLowerCase() !== jack.toLowerCase()) { skipped.push(ref); continue; }
      const cut = truncatedParts(pr);
      if (cut.length) truncated.push(`${ref} (${cut.join('/')})`);
      // Reload right before the write: another run may have saved while gh was slow, and merging is idempotent by source id.
      const store = loadStore(dir);
      const before = store.findings.length;
      store.findings = mergeItems(store.findings, itemsFrom(pr, ref, jack), today());
      if (!cut.length) store.harvested[ref] = today();
      saveStore(dir, store);
      added += store.findings.length - before;
      total = store.findings.length;
    } catch (e) { failed.push(`${ref}: ${(e as Error).message}`); }
  }
  return { added, skipped, failed, truncated, total };
}

function readSkills(dir: string): Record<string, string[]> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8').split('\n')]));
}

const where = (f: Finding): string => `${f.prs.join(', ')}${f.threads > 1 ? ` (${f.threads})` : ''}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** The weekly note, in batch 1's shape: summary, harvested findings by category, dropped, planning misses, candidates. Pure. */
export function renderBatch(findings: Finding[], triage: Map<string, Triage>, range: { since: string; until: string }, n: number): string {
  const done = findings.filter((f) => triage.has(f.id));
  const open = findings.length - done.length;
  const dropped = done.filter((f) => dropReason(triage.get(f.id)!));
  const planning = done.filter((f) => triage.get(f.id)!.klass === 'planning' && !dropped.includes(f));
  const real = done.filter((f) => !dropped.includes(f) && !planning.includes(f));
  const cov = (c: string) => real.filter((f) => triage.get(f.id)!.coverage === c).length;
  const L = [`---`, `stream: Mithril`, `date: ${range.until}`, `status: awaiting Jack's approval`, `---`, ``,
    `# Review misses, batch ${n} (${range.since} to ${range.until})`, ``, `Loop: [[copilot-feedback-loop]]. Previous batch: the newest earlier copilot-findings-batch note in this folder.`, ``, `## Summary`, ``,
    `- **Harvested:** ${findings.length} distinct findings from ${new Set(findings.flatMap((f) => f.prs)).size} PRs (${findings.reduce((s, f) => s + f.threads, 0)} threads; twins and repeat passes collapsed).`,
    `- **Mithril misses:** ${real.length} real. Coverage: ${cov('covered')} covered, ${cov('partial')} partial, ${cov('not-covered')} not covered.`,
    `- **Planning misses:** ${planning.length}. They go to the planning checklist, not to mithril.`,
    `- **Dropped:** ${dropped.length} (false positives, pre-existing code, things CI catches, declined nits).`,
    `- **Not yet triaged:** ${open}. A note is written only when this is 0.`, ``,
    `Coverage: **C** covered, **P** partial, **N** not covered. Fate: fixed, deferred, declined, resolved (thread resolved, fate unconfirmed), open.`, ``];
  const cats = [...new Set(real.map((f) => triage.get(f.id)!.category || 'Uncategorised'))].sort();
  L.push(`## Harvested findings`, ``);
  cats.forEach((c, i) => {
    L.push(`### ${String.fromCharCode(65 + i)}. ${c}`, ``, `| # | PR (threads) | File | Gist | Fate | Cov |`, `|---|---|---|---|---|---|`);
    real.filter((f) => (triage.get(f.id)!.category || 'Uncategorised') === c).forEach((f, j) => {
      const t = triage.get(f.id)!;
      L.push(`| ${String.fromCharCode(65 + i)}${j + 1} | ${where(f)} | ${cell(f.path.split('/').pop() || '-')} | ${cell(f.gist)} | ${t.fate} | ${({ covered: 'C', partial: 'P', 'not-covered': 'N' } as Record<string, string>)[t.coverage ?? ''] ?? '-'} |`);
    });
    L.push(``);
  });
  L.push(`## Planning misses (route to the planning checklist, Prior art step)`, ``, `| # | PR (threads) | Gist | Prior art that existed |`, `|---|---|---|---|`);
  planning.forEach((f, i) => L.push(`| Q${i + 1} | ${where(f)} | ${cell(f.gist)} | ${cell(triage.get(f.id)!.candidate ?? triage.get(f.id)!.why ?? '')} |`));
  L.push(``, `## Dropped (not mithril misses)`, ``, `| # | PR (threads) | Gist | Why |`, `|---|---|---|---|`);
  dropped.forEach((f, i) => L.push(`| X${i + 1} | ${where(f)} | ${cell(f.gist)} | ${cell(dropReason(triage.get(f.id)!) ?? '')} |`));
  const groups = new Map<string, { skill: string; text: string; cite: string; fs: Finding[] }>();
  for (const f of real) {
    const t = triage.get(f.id)!;
    if (!t.candidate || !t.skill) continue;
    const cite = t.cite ?? 'unsourced';
    const key = JSON.stringify([t.skill, t.candidate, cite]);
    const g = groups.get(key) ?? { skill: t.skill, text: t.candidate, cite, fs: [] };
    g.fs.push(f);
    groups.set(key, g);
  }
  L.push(``, `## Candidate skill updates (proposals; nothing ships without Jack's approval)`, ``, `| # | Skill / rule | Change (exact wording) | Citation | Evidence | Status |`, `|---|---|---|---|---|---|`);
  [...groups.values()].forEach(({ skill, text, cite, fs }, i) => {
    const status = cite === 'unsourced' ? 'blocked: unsourced' : candidateStatus(fs);
    L.push(`| ${i + 1} | \`${skill}\` | ${cell(text)} | ${cite} | ${fs.length} findings, ${new Set(fs.flatMap((f) => f.changes)).size} changes | ${status} |`);
  });
  return `${L.join('\n')}\n`;
}

function batchFileCount(out: string): number {
  return existsSync(out) ? readdirSync(out).filter((f) => /copilot-findings-batch-\d+\.md$/.test(f)).length : 0;
}

function main(argv: string[]): number {
  const cmd = argv[0];
  const a = parseArgs(argv);
  const dir = storeDir(a.arg('store'));
  const json = argv.includes('--json');
  if (cmd === 'harvest') {
    const jack = a.arg('jack', GH_LOGIN);
    if (!jack || !LOGIN.test(jack)) return fail('pass --jack <login> (or set gh_login)');
    const since = a.arg('since');
    const refs = a.positional.length ? a.positional : since ? mergedSince(jack, since) : [];
    if (!refs.length || refs.some((r) => !REF.test(r))) return fail('harvest needs owner/repo#N refs or --since YYYY-MM-DD with merged PRs');
    const r = harvest(refs, jack, dir);
    if (json) printJson(r); else console.log(`harvested ${refs.length - r.skipped.length - r.failed.length} PRs: ${r.added} new findings (${r.total} total); skipped ${r.skipped.length} not by ${jack}; ${r.failed.length} unreadable${r.truncated.length ? `; MORE THAN ONE PAGE, not fully read: ${r.truncated.join(', ')}` : ''}${r.failed.map((f) => `\n  ${f}`).join('')}`);
    return r.failed.length || r.truncated.length ? 2 : 0;
  }
  if (cmd === 'pending') {
    const done = loadTriage(dir);
    const skills = readSkills(a.arg('skills', join(fileURLToPath(new URL('../../mithril/skills', import.meta.url)))));
    const list = loadStore(dir).findings.filter((f) => !done.has(f.id)).map((f) => ({ ...f, srcIds: undefined, coverage: coverageHints(f.gist, skills) }));
    if (json) printJson(list); else for (const f of list) console.log(`${f.id} [${f.kind}] ${f.prs.join(', ')} ${f.path} hints=${f.hints.join('+') || '-'} fate=${f.fate}\n  ${f.gist}${f.coverage.map((c) => `\n  ~ ${c.skill} (${c.shared}): ${c.line}`).join('')}`);
    if (!list.length) console.log('nothing pending');
    return 0;
  }
  if (cmd === 'triage') {
    const id = a.positional[0] ?? '';
    const klass = a.arg('class') ?? '';
    const fate = a.arg('fate', 'open');
    const cov = a.arg('coverage');
    if (!loadStore(dir).findings.some((f) => f.id === id)) return fail(`no finding ${id}`);
    if (!CLASSES.includes(klass) || !['yes', 'no'].includes(a.arg('real') ?? '') || !FATES.includes(fate) || (cov && !COVERAGE.includes(cov))) return fail('bad --class, --real, --fate or --coverage');
    if (klass === 'dropped' && !a.arg('why')) return fail('a dropped finding needs --why');
    if (klass === 'mithril' && a.arg('candidate') && !a.arg('skill')) return fail('a candidate needs --skill');
    const rec: Triage = { id, klass: klass as Triage['klass'], fate: fate as Triage['fate'], real: a.arg('real') === 'yes', why: a.arg('why') ?? undefined, coverage: cov as Triage['coverage'] ?? undefined, skill: a.arg('skill') ?? undefined, cite: a.arg('cite') ?? undefined, category: a.arg('category') ?? undefined, candidate: a.arg('candidate') ?? undefined };
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'triage.jsonl'), `${JSON.stringify(rec)}\n`);
    console.log(`triaged ${id} as ${klass}`);
    return 0;
  }
  if (cmd === 'batch') {
    const until = a.arg('until', today());
    const since = a.arg('since', new Date(Date.parse(until) - 6 * 86400000).toISOString().slice(0, 10));
    if (!DATE.test(until) || !DATE.test(since)) return fail('--since and --until need YYYY-MM-DD');
    const out = a.arg('out', VAULT_ROOT ? join(VAULT_ROOT, 'Projects', 'mithril', 'Research') : '');
    const findings = loadStore(dir).findings.filter((f) => f.seen >= since && f.seen <= until);
    const triaged = loadTriage(dir);
    const nth = batchFileCount(out) + 1;
    const note = renderBatch(findings, triaged, { since, until }, nth);
    if (!a.has('write')) { console.log(note); return 0; }
    const untriaged = findings.filter((f) => !triaged.has(f.id)).length;
    if (untriaged) return fail(`${untriaged} findings are not triaged yet; triage them, then write the note`);
    if (!out) return fail('pass --out <dir> (or set vault_root) with --write');
    mkdirSync(out, { recursive: true });
    const file = join(out, `${until}-copilot-findings-batch-${nth}.md`);
    if (existsSync(file)) return fail(`${file} exists; not overwritten`);
    writeFileSync(file, note);
    console.log(file);
    return 0;
  }
  console.error('Usage: review-harvest.ts harvest|pending|triage|batch (see the header of this file)');
  return 2;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
