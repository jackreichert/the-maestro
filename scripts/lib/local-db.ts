/**
 * LOCAL DB: the logic behind `local-db`, a sanctioned way for an agent to query a LOCAL Postgres without ever seeing its URL.
 *
 * The named URL variable is read from the env file in this process and parsed here; it is never exported to a shell, put on a command
 * line, or printed. Every limit below is enforced in code (see local-db.test.ts), not described:
 *   - the host must be localhost or 127.0.0.1, the port must not be a prod or staging proxy port, and the variable name must not look like
 *     a prod, staging or shared database
 *   - the URL may carry no query parameters other than `sslmode` and `connect_timeout` (`host=`, `port=`, `options=` and `service=` would
 *     redirect the connection)
 *   - psql gets the connection as PG* environment variables (never an argument), with the caller's own PG* variables dropped
 *   - the session is read-only unless `write` is set; the caller's arguments are a small allowlist, and backslash commands that could
 *     reconnect, run a shell command or include a file are refused
 *   - stdout and stderr are scrubbed of the URL, the password and the user:password pair before anything is printed
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class LocalDbRefused extends Error {}

export const DEFAULT_VAR = 'LOCAL_DB_URL';
/** Preferred for read-only calls when set: a login role without superuser or server file/program roles, which is the real read-only boundary. */
export const RO_VAR = 'LOCAL_DB_RO_URL';
/** Ports the cloud-sql-proxy listens on: 5438 is the PROD interim proxy, 5439 the staging interim proxy. */
export const FORBIDDEN_PORTS: readonly number[] = [5438, 5439];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const FORBIDDEN_NAME = /PROD|PRD|STAGING|STG|SHARED/i;
const ALLOWED_QUERY = new Set(['sslmode', 'connect_timeout']);
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PSQL_CANDIDATES = ['/opt/homebrew/opt/postgresql@17/bin/psql', '/opt/homebrew/bin/psql', '/usr/local/bin/psql', '/usr/bin/psql'];
const READ_ONLY_BYPASS = /transaction_read_only|set_config|standard_conforming_strings|read\s+write|reset\s+all|session\s+authorization|set\s+role/i;
/** Server-side file, program and cross-database access: with a superuser local role these would read the host's files. A guardrail; a non-superuser role is the boundary. */
const SERVER_FILE_ACCESS = /pg_read_file|pg_read_binary_file|pg_ls_|pg_stat_file|pg_file_|lo_import|lo_export|lo_get|lo_put|\bcopy\b|\bprogram\b|dblink|postgres_fdw|adminpack|pg_execute_server/i;
/** Meta commands that only read catalog metadata or change display: \d family, \l, \x, \timing, and the \\ separator. */
const SAFE_META = /^(d[A-Za-z]{0,3}[+S]*|l[+]?|x|timing|\\)$/;

export interface LocalTarget { host: string; port: number; user: string; password: string; database: string; sslmode?: string; connectTimeout?: string; url: string }

export function defaultEnvFile(): string { return join(homedir(), 'dev-env', '.env'); }

/** The value of one variable from an env file, parsed (never sourced, so nothing in the file runs). Refuses when it is absent. */
export function readEnvValue(envFile: string, name: string): string {
  if (!VAR_NAME.test(name)) throw new LocalDbRefused('bad variable name');
  if (!existsSync(envFile)) throw new LocalDbRefused('the env file is missing');
  let found: string | undefined;
  for (const raw of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m || m[1] !== name) continue;
    let v = (m[2] ?? '').trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, '');
    found = v;
  }
  if (!found) throw new LocalDbRefused(`${name} is not set in the env file`);
  return found;
}

/** Parse the URL and refuse anything that is not a plain local connection. The refusal text never contains the URL. */
export function parseLocalUrl(name: string, url: string, dbOverride?: string): LocalTarget {
  if (FORBIDDEN_NAME.test(name)) throw new LocalDbRefused(`${name} looks like a prod, staging or shared database; local-db is localhost only`);
  let u: URL;
  try { u = new URL(url); } catch { throw new LocalDbRefused(`${name} is not a valid postgres URL`); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new LocalDbRefused(`${name} is not a postgres URL`);
  if (!LOCAL_HOSTS.has(u.hostname)) throw new LocalDbRefused(`refused: the host is not localhost or 127.0.0.1`);
  const port = u.port === '' ? 5432 : Number(u.port);
  if (FORBIDDEN_PORTS.includes(port)) throw new LocalDbRefused(`refused: port ${port} is a prod or staging proxy port`);
  for (const key of u.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key)) throw new LocalDbRefused(`refused: the URL carries a query parameter other than sslmode and connect_timeout`);
  }
  const database = dbOverride ?? decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (dbOverride !== undefined && !DB_NAME.test(dbOverride)) throw new LocalDbRefused('bad database name');
  if (!database) throw new LocalDbRefused('no database: pass --db NAME');
  return {
    host: u.hostname, port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database, url,
    sslmode: u.searchParams.get('sslmode') ?? undefined, connectTimeout: u.searchParams.get('connect_timeout') ?? undefined,
  };
}

/** Every string that must never reach the output: the URL, the user:password pair and the password, each raw and percent-encoded. */
export function secretsOf(t: LocalTarget): string[] {
  const out = new Set<string>([t.url]);
  if (t.password) { out.add(t.password); out.add(encodeURIComponent(t.password)); out.add(`${t.user}:${t.password}`); out.add(`${encodeURIComponent(t.user)}:${encodeURIComponent(t.password)}`); }
  return [...out].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets: string[]): string {
  let s = text;
  for (const secret of secrets) s = s.split(secret).join('***');
  return s;
}

/** The environment psql runs in: PATH plus the connection, and nothing the caller exported (no PGHOST, PGSERVICE, PGOPTIONS, ...). */
export function childEnv(t: LocalTarget, write: boolean): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C', PAGER: 'cat',
    PGHOST: t.host, PGPORT: String(t.port), PGUSER: t.user, PGDATABASE: t.database, PGCONNECT_TIMEOUT: t.connectTimeout ?? '10',
    PGOPTIONS: write ? '' : '-c default_transaction_read_only=on',
  };
  if (t.password) env.PGPASSWORD = t.password;
  if (t.sslmode) env.PGSSLMODE = t.sslmode;
  return env;
}

/**
 * Scan psql input for backslash commands outside quotes and comments. Returns the first unsafe command, or undefined. Backticks outside
 * quotes are unsafe too (psql runs them in a shell). Fail closed: anything not on the allowlist is refused.
 */
export function unsafeMeta(text: string): string | undefined {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === "'") {
      const escape = /[eE]/.test(text[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(text[i - 2] ?? ' ');
      i++;
      while (i < n) {
        if (escape && text[i] === '\\') { i += 2; continue; }
        if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } break; }
        i++;
      }
      i++; continue;
    }
    if (c === '"') { i++; while (i < n && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1; i++; continue; }
    if (c === '$' && !/[A-Za-z0-9_$\u0080-\uffff]/.test(text[i - 1] ?? ' ')) {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) { const end = text.indexOf(tag, i + tag.length); i = end === -1 ? n : end + tag.length; continue; }
    }
    if (c === '-' && text[i + 1] === '-') { const e = text.indexOf('\n', i); i = e === -1 ? n : e + 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '`') return '`';
    if (c === '\\') {
      const name = /^\\(\\|[A-Za-z]+[+S]*|[^A-Za-z\s])/.exec(text.slice(i))?.[1] ?? '';
      if (!SAFE_META.test(name)) return `\\${name}`;
      // psql reads a meta command's arguments to the end of the line and does not honour SQL quotes or comments there, so a later
      // backslash or backtick on the same line is a second command (`\dt $$ \! id $$`): refuse it whatever it is wrapped in.
      const eol = text.indexOf('\n', i);
      const rest = text.slice(i + 1 + name.length, eol === -1 ? n : eol);
      if (/[\\`]/.test(rest)) return '\\ or a backtick after a backslash command';
      i = eol === -1 ? n : eol + 1; continue;
    }
    i++;
  }
  return undefined;
}

function hasValue(envFile: string, name: string): boolean {
  try { return readEnvValue(envFile, name) !== ''; } catch { return false; }
}

export interface Request { args: string[]; db?: string; write?: boolean; varName?: string }
export interface Planned { argv: string[]; input?: string; target: LocalTarget; varName: string }
export interface Deps { envFile?: string; psqlPath?: string }

/** Flags psql may be given: output shape and the SQL itself. Anything else (-h, -p, -U, -d, -P, -o, -L, -W, URIs) is refused. */
const FLAG_ONLY = new Set(['-A', '-t', '-x', '-q', '-H', '-1', '--csv', '--no-align', '--tuples-only', '--expanded', '--quiet', '--html', '--single-transaction', '-X', '--no-psqlrc']);
const FLAG_VALUE = new Set(['-F', '-R', '--field-separator', '--record-separator']);

/** Validate the request and build psql's argv. Throws LocalDbRefused; never returns anything holding the URL. */
export function plan(req: Request, deps: Deps = {}): Planned {
  const envFile = deps.envFile ?? defaultEnvFile();
  const name = req.varName ?? (!req.write && hasValue(envFile, RO_VAR) ? RO_VAR : DEFAULT_VAR);
  const target = parseLocalUrl(name, readEnvValue(envFile, name), req.db);
  const argv = ['-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off'];
  const texts: string[] = [];
  let input: string | undefined;
  const a = req.args;
  for (let i = 0; i < a.length; i++) {
    const f = a[i] as string;
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(f);
    const flag = eq ? (eq[1] as string) : f;
    const take = (): string => { if (eq) return eq[2] as string; if (i + 1 >= a.length) throw new LocalDbRefused(`${flag} needs a value`); return a[++i] as string; };
    if (FLAG_ONLY.has(flag) && !eq) argv.push(flag);
    else if (FLAG_VALUE.has(flag)) argv.push(flag, take());
    else if (flag === '-c' || flag === '--command') { const v = take(); texts.push(v); argv.push('-c', v); }
    else throw new LocalDbRefused(`refused: argument ${flag.startsWith('-') ? flag : '(positional)'} is not allowed; pass -c SQL and output flags, and use --db to pick the database`);
  }
  if (!texts.length) throw new LocalDbRefused('refused: pass the SQL with -c (stdin scripts and -f are not accepted)');
  for (const t of texts) {
    const bad = unsafeMeta(t);
    if (bad) throw new LocalDbRefused(`refused: ${bad === '`' ? 'a backtick' : `the backslash command ${bad}`} is not allowed (allowed: \\d family, \\l, \\x, \\timing)`);
    if (SERVER_FILE_ACCESS.test(t)) throw new LocalDbRefused('refused: server-side file, program and cross-database access (pg_read_file, COPY, lo_import, dblink, ...) is not allowed');
    if (!req.write && READ_ONLY_BYPASS.test(t)) throw new LocalDbRefused('refused: that statement could switch the session out of read-only; pass --write for a local write');
  }
  return { argv, input, target, varName: name };
}

/** 't' when the connecting role is a superuser or holds a server file or program role (it could read host files or run programs). */
const PRIVILEGE_PREFLIGHT = `select coalesce(bool_or(r.rolsuper), false) or pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') or pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') or pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') from pg_roles r where pg_has_role(current_user, r.oid, 'MEMBER')`;

export function findPsql(deps: Deps = {}): string {
  if (deps.psqlPath) return deps.psqlPath;
  const p = PSQL_CANDIDATES.find((c) => existsSync(c));
  if (!p) throw new LocalDbRefused('psql not found in the standard locations');
  return p;
}

export interface RunResult { status: number; stdout: string; stderr: string }

/** Run psql for the request. All output is scrubbed; a refusal comes back as status 2 with a message that holds no secret. */
export function run(req: Request, deps: Deps = {}): RunResult {
  let planned: Planned;
  try { planned = plan(req, deps); } catch (e) {
    if (e instanceof LocalDbRefused) return { status: 2, stdout: '', stderr: `local-db: ${e.message}\n` };
    throw e;
  }
  const secrets = secretsOf(planned.target);
  let psql: string;
  try { psql = findPsql(deps); } catch (e) { return { status: 2, stdout: '', stderr: `local-db: ${(e as Error).message}\n` }; }
  const pre = spawnSync(psql, ['-X', '-A', '-t', '-c', PRIVILEGE_PREFLIGHT], { env: childEnv(planned.target, false), encoding: 'utf8', timeout: 30_000 });
  const privileged = pre.status === 0 && pre.stdout.trim() === 't';
  if (privileged && planned.varName === RO_VAR) return { status: 2, stdout: '', stderr: `local-db: refused: ${RO_VAR} connects as a role that is a superuser or has server file or program roles; use a restricted role\n` };
  if (planned.varName === RO_VAR && !(pre.status === 0 && pre.stdout.trim() === 'f')) return { status: 2, stdout: '', stderr: `local-db: refused: could not verify that ${RO_VAR} connects as a restricted role\n` };
  const r = spawnSync(psql, planned.argv, { env: childEnv(planned.target, !!req.write), input: planned.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const stderr = r.error ? `local-db: could not run psql: ${(r.error as Error).message}\n` : r.stderr;
  const note = privileged ? `local-db: note: ${planned.varName} connects as a superuser or a role with server file or program roles, so read-only mode and the SQL denylist are best-effort guardrails; set ${RO_VAR} to a restricted role for a hard boundary\n` : '';
  return { status: r.status ?? 1, stdout: scrub(r.stdout ?? '', secrets), stderr: note + scrub(stderr ?? '', secrets) };
}
