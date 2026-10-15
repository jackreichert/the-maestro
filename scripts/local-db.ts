#!/usr/bin/env node
/**
 * LOCAL DB: run psql against Jack's LOCAL Postgres without seeing its URL.
 *
 *   local-db [--var NAME] [--db NAME] [--write] [--info] -c "SQL" [-A -t -x -q -H --csv -F SEP ...]
 *   local-db --db NAME -f script.sql          (or SQL on stdin)
 *
 * Reads LOCAL_DB_URL (or --var NAME) from ~/dev-env/.env inside this process. Refuses unless the host is localhost or 127.0.0.1, the
 * port is not a prod or staging proxy port (5438, 5439), and the variable is not a prod, staging or shared one. `--db` replaces the URL's
 * database (psql ignores -d beside a URI). The session is read-only unless `--write`. Nothing prints the URL or password; `--info`
 * prints host, port and database only. Logic and tests: scripts/lib/local-db.ts, scripts/local-db.test.ts.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VAR, LocalDbRefused, defaultEnvFile, parseLocalUrl, readEnvValue, run } from './lib/local-db.ts';

const USAGE = 'usage: local-db [--var NAME] [--db NAME] [--write] [--info] [-c SQL | -f FILE] [psql output flags: -A -t -x -q -H --csv -F SEP -R SEP -v NAME=VALUE]';

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  let db: string | undefined; let varName: string | undefined; let write = false; let info = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--write') write = true;
    else if (a === '--info') info = true;
    else if (a === '--db' || a === '--var') {
      const v = argv[++i];
      if (v === undefined) { console.error(USAGE); return 2; }
      if (a === '--db') db = v; else varName = v;
    } else rest.push(a);
  }
  if (info) {
    try {
      const t = parseLocalUrl(varName ?? DEFAULT_VAR, readEnvValue(defaultEnvFile(), varName ?? DEFAULT_VAR), db);
      console.log(`host=${t.host} port=${t.port} database=${t.database} mode=${write ? 'write' : 'read-only'}`);
      return 0;
    } catch (e) {
      if (!(e instanceof LocalDbRefused)) throw e;
      console.error(`local-db: ${e.message}`); return 2;
    }
  }
  const r = run({ args: rest, db, write, varName });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.status;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
