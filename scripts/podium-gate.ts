#!/usr/bin/env node
/**
 * PODIUM GATE: checks a running Podium against the v1 bar and reports each criterion as pass, fail or not built yet.
 *
 *   node scripts/podium-gate.ts                  start a temp Podium (fictional data, temp directory) and check it
 *   node scripts/podium-gate.ts --url <base>     check a Podium that is already running (`journal.ts web` prints its URL)
 *   node scripts/podium-gate.ts --json           the results as JSON
 *
 * It reads the Podium over HTTP only; the plain-language library rule is read from this checkout. A piece that is not built yet is reported,
 * never an error. Exit 0 when every criterion passes, 1 when any does not, 2 on a usage error or when a --url Podium does not answer at all.
 */
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render, runGate } from './lib/podium-gate/checks.ts';
import { httpProbe } from './lib/podium-gate/probe.ts';
import { printJson } from './lib/json-out.ts';
import { startTempPodium } from './lib/podium-gate/temp-podium.ts';

const USAGE = 'Usage: podium-gate.ts [--url <http://127.0.0.1:port/>] [--json]';

async function main(argv: string[]): Promise<number> {
  let values: { url?: string; json?: boolean; help?: boolean };
  try { values = parseArgs({ args: argv, options: { url: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values; } catch (e) { console.error(`${e instanceof Error ? e.message.split('\n')[0] : 'bad arguments'}\n${USAGE}`); return 2; }
  if (values.help) { console.log(USAGE); return 0; }
  if (values.url !== undefined && !/^https?:\/\//.test(values.url)) { console.error(`--url must be an http(s) address\n${USAGE}`); return 2; }
  const temp = values.url === undefined ? await startTempPodium() : null;
  try {
    const probe = httpProbe(values.url ?? (temp as { url: string }).url);
    if ((await probe.get('/api/state')).status === 0) { console.error(`nothing answers at ${values.url}`); return 2; }
    const results = await runGate(probe);
    const { text, code } = render(results);
    if (values.json) printJson(results);
    else console.log(`${temp ? 'Checked a temp Podium with fictional data.\n\n' : ''}${text}`);
    return code;
  } finally { await temp?.close(); }
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(`podium-gate: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); process.exitCode = 2; });
