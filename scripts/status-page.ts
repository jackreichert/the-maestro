#!/usr/bin/env node
/**
 * status-page.ts: regenerate the Podium, the always-current status page (The-Podium.md) from the ledger and GitHub.
 * Normally run as `journal.ts status-page`, which passes the ledger root and project through.
 *
 *   status-page.ts [--dry-run] [--snapshot] [--status-dir <dir>] [--vault <ledger root>] [--project <name>]
 *
 *   --dry-run         print the page to stdout; write nothing
 *   --snapshot        also write YYYY-MM-DD.md (today's file, overwritten by later runs)
 *   --status-dir DIR  where the page and its files live (default: status_dir, else <vault_root>/Projects/<project>/Status)
 *
 * The page has Working on now (in-flight items by stream) under the priorities and a Status table (the reply footer's numbers
 * from `status --json`'s `footer`) at the bottom; neither is an answer area.
 *
 * Reads `journal.ts status --json` and `triage --json`, a GitHub search of your open PRs (retried 3 times on a gateway
 * error) and, beside the page, ticket-map.json ({ "<ticket>": ["<ask id>"] }), stream-overrides.json ({ "repo#N": "Stream" })
 * and priorities.md. Streams, tracker URLs, vault name and the repo-to-stream map come from local-config.ts.
 * Exits non-zero, writing nothing, if the ledger cannot be read. If GitHub cannot be read, the page is still written
 * from the last cached PR data (.now-prs.json) under a warning, and a note goes to stderr.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, OBSIDIAN_VAULT, PR_SEARCH, REVIEW_QUEUE_CAP, STATUS_REPO_STREAMS, STATUS_STREAMS, TICKET_NOTE_PATH, TRACKER_KEY_PATTERN, TRACKER_URL_BASE, VAULT_ROOT, WATCH_TZ, statusDirFor } from './local-config.ts';
import { noteExistsIn, vaultRootFor } from './lib/status-page/links.ts';
import { generate } from './lib/status-page/generate.ts';
import type { GenerateDeps, GenerateResult, RawPr } from './lib/status-page/generate.ts';
import type { PageConfig } from './lib/status-page/render.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const PR_QUERY = `query{search(query:"${PR_SEARCH} archived:false",type:ISSUE,first:100){issueCount nodes{... on PullRequest{
number title url isDraft baseRefName headRefName mergeable mergeStateStatus reviewDecision repository{nameWithOwner}
reviewThreads(first:100){nodes{isResolved}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** The first line of a caught value's message. */
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

function fetchPrs(): RawPr[] {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) sleep(3000);
    try {
      const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${PR_QUERY}`], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return (JSON.parse(out).data.search.nodes as RawPr[]).filter((n) => n && n.number);
    } catch (e) { last = firstLine(e); }
  }
  throw new Error(`gh read failed after 3 tries: ${last}`);
}

/** `journal.ts <sub> --json` run as a child so the page sees exactly what `status` and `triage` print. */
function journalJson(sub: string, ledger: string, project: string): unknown {
  const r = spawnSync(process.execPath, [`${HERE}journal.ts`, sub, '--json', '--vault', ledger, '--project', project],
    { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`ledger read failed (journal.ts ${sub}): ${(r.stderr || r.stdout).split('\n')[0]}`);
  return JSON.parse(r.stdout);
}

/** The install's page settings from the local config; the Markdown page and the web server read the same ones. */
export function pageConfig(project = '', statusDir = ''): PageConfig {
  return {
    streams: STATUS_STREAMS, repoStreams: STATUS_REPO_STREAMS, vaultName: OBSIDIAN_VAULT, trackerUrlBase: TRACKER_URL_BASE,
    ticketNotePath: TICKET_NOTE_PATH, trackerKeyPattern: TRACKER_KEY_PATTERN, tz: WATCH_TZ, reviewQueueCap: REVIEW_QUEUE_CAP,
    project, noteExists: noteExistsIn(vaultRootFor(VAULT_ROOT, statusDir)),
  };
}

export interface RegenerateOptions { project: string; ledger: string; statusDir: string; dryRun: boolean; snapshot: boolean; cachedPrsOnly: boolean }

/** One page rebuild with the real ledger, GitHub and clock. `cachedPrsOnly` skips the GitHub read and renders the last cached PR set. Throws if the ledger cannot be read or no directory is set. */
export function regenerate(o: RegenerateOptions): GenerateResult {
  if (!o.ledger) throw new Error('Ledger root is not set. Set ledger_root (LEDGER_ROOT) or pass --vault <path>.');
  if (!o.statusDir) throw new Error('No status directory. Set status_dir or vault_root in the local config, or pass --status-dir <dir>.');
  const deps: GenerateDeps = { journal: (sub) => journalJson(sub, o.ledger, o.project), fetchPrs, sleep, now: () => new Date() };
  return generate({ statusDir: o.statusDir, dryRun: o.dryRun, snapshot: o.snapshot, cachedPrsOnly: o.cachedPrsOnly, command: 'journal.ts podium', config: pageConfig(o.project, o.statusDir) }, deps);
}

function main(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, options: {
    'dry-run': { type: 'boolean' }, snapshot: { type: 'boolean' }, 'status-dir': { type: 'string' }, vault: { type: 'string' }, project: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) { console.log('Usage: status-page.ts [--dry-run] [--snapshot] [--status-dir <dir>] [--vault <ledger root>] [--project <name>]'); return 0; }
  const project = v.project || CONFIGURED_PROJECT || CONTAINER_PROJECT;
  const ledger = v.vault || LEDGER_ROOT || VAULT_ROOT;
  const statusDir = v['status-dir'] || statusDirFor(project);
  const r = regenerate({ project, ledger, statusDir, dryRun: !!v['dry-run'], snapshot: !!v.snapshot, cachedPrsOnly: false });
  if (v['dry-run']) process.stdout.write(r.page); else console.log(`status-page: wrote ${r.written.join(' and ')}`);
  if (r.prFailure) console.error(`status-page: GitHub read failed (${r.prFailure}); the page carries a warning and uses the last cached PR data`);
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`status-page: ${firstLine(e)}`); process.exitCode = 1; }
}
