#!/usr/bin/env node
/**
 * install-podium-web.ts: fills the launchd plist template for the Podium web server and PRINTS the launchctl commands. It never
 * runs launchctl: loading a LaunchAgent is a machine change you make yourself. launchd then starts the server at login and
 * restarts it whenever it exits, so the page the footer links to stays up without a session.
 *
 *   install-podium-web.ts [--port <n>] [--out <plist path>] [--log <log path>]
 *
 * Needs a ledger root (LEDGER_ROOT). The port defaults to the one in `status_page_uri` (the footer link), else 47700. Exit 0 wrote the plist, 2 refused.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fillTemplate, shq } from './install-loop-supervisor.ts';
import { launchAgentsDir } from './lib/supervisor-state.ts';
import { CONTAINER_PROJECT, LEDGER_ROOT, STATUS_PAGE_URI_SETTING } from './local-config.ts';

export const WEB_LABEL = 'com.jackreichert.the-maestro-web';
export const DEFAULT_PORT = 47700;
const TEMPLATE = fileURLToPath(new URL(`./launchd/${WEB_LABEL}.plist.template`, import.meta.url));
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** The port in a loopback `status_page_uri` such as http://127.0.0.1:47700/, or the default. */
export function portFromUri(uri: string | undefined): number {
  const m = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})(?:\/|$)/.exec(uri ?? '');
  const port = m ? Number(m[1]) : DEFAULT_PORT;
  return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

/** The commands the user runs, in order. `uid` is the numeric user id launchd's gui domain is keyed by. */
export const webCommands = (plist: string, uid: number): { load: string; check: string; restart: string; unload: string } => ({
  load: `launchctl bootstrap gui/${uid} ${shq(plist)}`,
  check: `launchctl print gui/${uid}/${WEB_LABEL}`,
  restart: `launchctl kickstart -k gui/${uid}/${WEB_LABEL}`,
  unload: `launchctl bootout gui/${uid}/${WEB_LABEL}`,
});

function main(argv: string[]): number {
  const fail = (msg: string): number => { console.error(`install-podium-web: ${msg}`); return 2; };
  const { values: v } = parseArgs({ args: argv, options: { port: { type: 'string' }, out: { type: 'string' }, log: { type: 'string' } } });
  if (!LEDGER_ROOT) return fail('no ledger root; set LEDGER_ROOT (or ledger_root in the config)');
  const port = v.port === undefined ? portFromUri(STATUS_PAGE_URI_SETTING) : Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('--port must be a whole number from 1 to 65535');
  const project = CONTAINER_PROJECT;
  const out = v.out ?? join(launchAgentsDir(), `${WEB_LABEL}.plist`);
  const log = v.log ?? join(LEDGER_ROOT, 'Projects', project, 'Journal', 'Supervisor', 'podium-web.log');
  const path = [...new Set([dirname(process.execPath), ...BASE_PATH])].join(':');
  const plist = fillTemplate(readFileSync(TEMPLATE, 'utf8'), { NODE: realpathSync(process.execPath), REPO, PORT: String(port), LEDGER_ROOT, PROJECT: project, LOG: log, PATH: path });
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(out, plist);
  const c = webCommands(out, process.getuid?.() ?? 501);
  console.log(`wrote ${out}\nrepo ${REPO}${REPO.includes('/.worktrees/') ? '  (a worktree; install from the main checkout so the path survives)' : ''}\nport ${port}\n\nload:    ${c.load}\ncheck:   ${c.check}\nrestart: ${c.restart}\nunload:  ${c.unload}\nlog:     ${log}\n\nNothing was loaded. Run the load command yourself (stop any hand-started server on the port first).`);
  return 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
