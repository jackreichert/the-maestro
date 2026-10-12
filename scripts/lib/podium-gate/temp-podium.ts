/**
 * A throwaway Podium for the gate to probe: a temp ledger and vault holding one fictional stream with one project's notes, served by the real
 * server from this checkout's client files. Nothing outside the temp directory is read or written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../journal/store.ts';
import { createWebServer } from '../web/server.ts';

const CLIENT = fileURLToPath(new URL('../../web/client/', import.meta.url));
const STREAM = 'Widgets';
const PROJECT = 'widgets';

const CONTEXT = '---\nupdated: 2026-10-01\n---\n# Widgets\n\nA small service that sorts widgets for the orchard dashboards.\n\n## Now\n\n- Backfill running\n\n## Next\n\n1. Retire the old cron\n';
const INDEX = '# Index\n\n<!-- library-index:start -->\n- [[how-it-sorts]]: how-it-works, you change the sorter (verified 2026-10-01)\n<!-- library-index:end -->\n';
const runbook = (kind: string): string => `---\ntype: library\ntags: [${kind}]\nupdated: 2026-10-01\n---\n# ${kind} widgets\n\nSteps to ${kind} the service.\n`;

export interface TempPodium { url: string; close: () => Promise<void> }

/** Start the temp Podium on 127.0.0.1 (a free port). `close` stops it and removes the temp directory. */
export async function startTempPodium(now: Date = new Date()): Promise<TempPodium> {
  const root = mkdtempSync(join(tmpdir(), 'podium-gate-'));
  const vault = join(root, 'vault');
  const statusDir = join(vault, 'Status');
  const project = join(vault, 'Projects', PROJECT);
  for (const d of [statusDir, join(project, 'Runbooks'), join(project, 'Knowledge'), join(project, 'Tickets')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, 'CONTEXT.md'), CONTEXT);
  writeFileSync(join(project, 'INDEX.md'), INDEX);
  writeFileSync(join(project, 'DECISIONS.md'), '# Decisions\n\n- 2026-10-01: sort nightly, because the dashboards read once a day.\n');
  for (const k of ['setup', 'run', 'test', 'deploy']) writeFileSync(join(project, 'Runbooks', `${k}.md`), runbook(k));
  writeFileSync(join(statusDir, 'stream-homes.json'), JSON.stringify({ version: 1, streams: { [STREAM]: { projects: [PROJECT] } } }));
  const ts = now.toISOString();
  openStore({ vault, project: 'gate', dryRun: false }).append({ id: 'gate1', kind: 'question', text: 'Ship the sorter? Context here.', stream: STREAM, ts, date: ts.slice(0, 10) });
  const web = { vault, project: 'gate', statusDir, vaultRoot: vault, page: { streams: [STREAM], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' } };
  const server = createWebServer({ web, clientDir: CLIENT, now: () => now, log: () => {} });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: async () => { await new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); },
  };
}
