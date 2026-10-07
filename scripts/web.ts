#!/usr/bin/env node
/**
 * web.ts: serve the Podium as a read-only local web page. Normally run as `journal.ts web`, which passes the ledger root and project.
 *
 *   web.ts [--port <n>] [--status-dir <dir>] [--vault <ledger root>] [--project <name>]
 *
 *   --port N          listen on 127.0.0.1:N (default 0: the OS picks a free port; the URL is printed)
 *   --status-dir DIR  where priorities.md, .now-prs.json, ticket-map.json and fragments/ live (default as for `podium`)
 *
 * Binds 127.0.0.1 only and answers only GET. It reads the ledger, the PR cache and priorities; it never writes them and never calls GitHub.
 * The page itself is built by `npm run build:web`; without that build the server still answers /api/* and says so.
 */
import { existsSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT, statusDirFor } from './local-config.ts';
import { pageConfig } from './status-page.ts';
import { createWebServer } from './lib/web/server.ts';

const CLIENT = fileURLToPath(new URL('./web/client/', import.meta.url));

function main(argv: string[]): void {
  const { values: v } = parseArgs({ args: argv, options: { port: { type: 'string', default: '0' }, 'status-dir': { type: 'string' }, vault: { type: 'string' }, project: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (v.help) { console.log('Usage: web.ts [--port <n>] [--status-dir <dir>] [--vault <ledger root>] [--project <name>]'); return; }
  const port = Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a whole number from 0 to 65535');
  const project = v.project || CONFIGURED_PROJECT || CONTAINER_PROJECT;
  const vault = v.vault || LEDGER_ROOT || VAULT_ROOT;
  const statusDir = v['status-dir'] || statusDirFor(project);
  if (!vault) throw new Error('Ledger root is not set. Set ledger_root (LEDGER_ROOT) or pass --vault <path>.');
  if (!statusDir) throw new Error('No status directory. Set status_dir or vault_root in the local config, or pass --status-dir <dir>.');
  const server = createWebServer({ web: { vault, project, statusDir, page: pageConfig(project, statusDir), ...(VAULT_ROOT ? { vaultRoot: VAULT_ROOT } : {}) }, clientDir: CLIENT });
  server.once('error', (e) => { console.error(`web: ${e.message.split('\n')[0]}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Podium web: http://127.0.0.1:${(server.address() as AddressInfo).port}/  (read-only; Ctrl-C to stop)`);
    if (!existsSync(join(CLIENT, 'dist', 'app.js'))) console.error('web: the page is not built yet; run `npm run build:web` and restart (the /api endpoints work without it)');
  });
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`web: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); process.exitCode = 1; }
}
