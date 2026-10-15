// Run: node --test scripts/local-db.test.ts
// Every URL, password and env file here is a fixture with obviously fake values; no real file or database is touched.
// A fake `psql` shell script stands in for the real one and echoes what it was given, so the tests can see exactly what reaches psql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./local-db.ts', import.meta.url).pathname;
const { run, plan, parseLocalUrl, readEnvValue, unsafeMeta, LocalDbRefused } = await import('./lib/local-db.ts');

const PASSWORD = 'fake-pw-hunter22';
const SCHEME = 'postgresql://';
/** A fixture URL, assembled from parts so no source line looks like a real credential. */
const mk = (hostPort: string, opts: { pw?: string; db?: string; query?: string; user?: string } = {}): string =>
  [SCHEME, opts.user ?? 'fake_user', ':', opts.pw ?? PASSWORD, '@', hostPort, '/', opts.db ?? 'fake_db', opts.query ? `?${opts.query}` : ''].join('');
const URL_OK = mk('localhost:5432');
const root = mkdtempSync(join(tmpdir(), 'localdb-'));

function envFile(lines: string[], name = '.env'): string {
  const dir = mkdtempSync(join(root, 'e-'));
  const f = join(dir, name);
  writeFileSync(f, lines.join('\n') + '\n');
  return f;
}
/** A fake psql: prints its argv, stdin and PG* env on stdout, and the URL and password on stderr (as a leaky real one might). */
function fakePsql(priv = 'f'): string {
  const f = join(root, `psql-fake-${priv}`);
  const url = ['postgresql:/', '/$PGUSER:$PGPASSWORD', '@$PGHOST:$PGPORT/$PGDATABASE'].join('');
  writeFileSync(f, [
    '#!/bin/sh',
    `case "$*" in *rolsuper*) echo ${priv}; exit 0;; esac`,
    'echo "ARGV:$*"',
    'echo "STDIN:$(cat)"',
    'echo "PGHOST=$PGHOST PGPORT=$PGPORT PGUSER=$PGUSER PGDATABASE=$PGDATABASE PGOPTIONS=[$PGOPTIONS] PGSERVICE=[$PGSERVICE]"',
    `echo "LEAK-OUT password=$PGPASSWORD url=${url}"`,
    `echo "psql: error: connection to ${url} failed pw=$PGPASSWORD" >&2`,
    'exit 3',
  ].join('\n') + '\n');
  chmodSync(f, 0o755);
  return f;
}
const PSQL = fakePsql();
const PSQL_PRIV = fakePsql('t');
const ok = (args: string[], extra: { db?: string; write?: boolean; varName?: string } = {}, vars = [`LOCAL_DB_URL=${URL_OK}`]) =>
  run({ args, ...extra }, { envFile: envFile(vars), psqlPath: PSQL });
const withUrl = (url: string, name = 'LOCAL_DB_URL') => [`${name}=${url}`];
const refusedMessage = (args: string[], extra = {}, vars = [`LOCAL_DB_URL=${URL_OK}`]): string => {
  const r = ok(args, extra, vars);
  assert.equal(r.status, 2, `expected refusal, got ${JSON.stringify(r)}`);
  assert.equal(r.stdout, '');
  assert.ok(!r.stderr.includes(PASSWORD) && !r.stderr.includes(SCHEME), 'a refusal must not echo the URL');
  return r.stderr;
};

test('host: only localhost and 127.0.0.1 are accepted', () => {
  for (const host of ['example.com', '10.0.0.5', 'localhost.evil.com', 'db.internal', '0.0.0.0', '[::1]']) {
    assert.match(refusedMessage(['-c', 'select 1'], {}, withUrl(mk(`${host}:5432`))), /host is not localhost/, host);
  }
  assert.equal(ok(['-c', 'select 1'], {}, withUrl(mk('127.0.0.1:5432'))).status, 3);
});

test('URL query parameters cannot redirect the connection', () => {
  for (const query of ['host=prod.example.com', 'hostaddr=10.0.0.1', 'port=5438', 'options=-c%20x%3Dy', 'service=prod']) {
    assert.match(refusedMessage(['-c', 'select 1'], {}, withUrl(mk('localhost:5432', { query }))), /query parameter/, query);
  }
  assert.equal(ok(['-c', 'select 1'], {}, withUrl(mk('localhost:5432', { query: 'sslmode=disable' }))).status, 3);
  assert.match(refusedMessage(['-c', 'select 1'], {}, withUrl(mk('localhost:5432,prod.example.com:5432'))), /not a valid postgres URL/);
});

test('ports: the prod proxy (5438) and staging proxy (5439) are refused even on localhost', () => {
  for (const port of [5438, 5439]) {
    for (const host of ['localhost', '127.0.0.1']) {
      assert.match(refusedMessage(['-c', 'select 1'], {}, withUrl(mk(`${host}:${port}`))), new RegExp(`port ${port}`));
    }
  }
  assert.equal(ok(['-c', 'select 1'], {}, withUrl(mk('localhost:5435'))).status, 3);
});

test('variable names that look like prod, staging or shared are refused whatever the host', () => {
  for (const name of ['PRODUCTION_DB_URL', 'STAGING_DB_URL', 'SHARED_ORG_DB', 'PRD_URL', 'LOCAL_PROD_URL']) {
    assert.match(refusedMessage(['-c', 'select 1'], { varName: name }, withUrl(URL_OK, name)), /localhost only/, name);
  }
  assert.equal(ok(['-c', 'select 1'], { varName: 'INTERIM_LOCAL_URL' }, withUrl(URL_OK, 'INTERIM_LOCAL_URL')).status, 3);
});

test('the URL and password never reach stdout or stderr, even when psql prints them', () => {
  const r = ok(['-c', 'select 1']);
  assert.equal(r.status, 3);
  for (const out of [r.stdout, r.stderr]) {
    assert.ok(!out.includes(PASSWORD), out);
    assert.ok(!out.includes('fake_user:'), out);
    assert.ok(!out.includes(SCHEME), out);
  }
  assert.match(r.stdout, /LEAK-OUT password=\*\*\* url=\*\*\*/);
  assert.match(r.stderr, /pw=\*\*\*/);
});

test('a short password is still scrubbed', () => {
  const r = ok(['-c', 'select 1'], {}, withUrl(mk('localhost:5432', { pw: 'ab' })));
  assert.ok(!/pw=ab\b/.test(r.stderr) && /pw=\*\*\*/.test(r.stderr));
});

test('a percent-encoded password is scrubbed in both forms', () => {
  const fancy = 'p@ss/w:rd!9';
  const r = ok(['-c', 'select 1'], {}, withUrl(mk('localhost:5432', { pw: encodeURIComponent(fancy) })));
  assert.ok(!r.stdout.includes(fancy) && !r.stderr.includes(fancy) && !r.stdout.includes(encodeURIComponent(fancy)));
});

test('the connection reaches psql as PG* variables, never as an argument', () => {
  const r = ok(['-c', 'select 1']);
  const argv = /^ARGV:(.*)$/m.exec(r.stdout)?.[1] ?? '';
  assert.ok(!argv.includes('postgresql') && !argv.includes(PASSWORD) && !argv.includes('localhost'), argv);
  assert.match(r.stdout, /PGHOST=localhost PGPORT=5432 PGUSER=fake_user PGDATABASE=fake_db/);
});

test('read-only by default; --write lifts it', () => {
  assert.match(ok(['-c', 'select 1']).stdout, /PGOPTIONS=\[-c default_transaction_read_only=on\]/);
  assert.match(ok(['-c', 'insert into t values (1)'], { write: true }).stdout, /PGOPTIONS=\[\]/);
});

test('read-only mode refuses statements that would switch it off; --write allows them', () => {
  for (const sql of ['set default_transaction_read_only = off', "select set_config('transaction_read_only','off',false)", 'begin read write', 'set role postgres', 'reset all']) {
    assert.match(refusedMessage(['-c', sql]), /out of read-only/, sql);
  }
  assert.equal(ok(['-c', 'set role other'], { write: true }).status, 3);
});

test('a privileged role is noted, and refused outright when it is the restricted read-only variable', () => {
  const run1 = (vars: string[], write = false) => run({ args: ['-c', 'select 1'], write }, { envFile: envFile(vars), psqlPath: PSQL_PRIV });
  const priv = run1([`LOCAL_DB_URL=${URL_OK}`]);
  assert.equal(priv.status, 3);
  assert.match(priv.stderr, /best-effort guardrails/);
  const ro = run1([`LOCAL_DB_URL=${URL_OK}`, `LOCAL_DB_RO_URL=${URL_OK}`]);
  assert.equal(ro.status, 2);
  assert.match(ro.stderr, /LOCAL_DB_RO_URL connects as a role/);
  assert.equal(run1([`LOCAL_DB_URL=${URL_OK}`, `LOCAL_DB_RO_URL=${URL_OK}`], true).status, 3);
  assert.doesNotMatch(ok(['-c', 'select 1']).stderr, /best-effort/);
});

test('LOCAL_DB_RO_URL fails closed when the role check cannot be completed', () => {
  const bad = join(root, 'psql-bad'); writeFileSync(bad, '#!/bin/sh\necho garbage\nexit 1\n'); chmodSync(bad, 0o755);
  const garbage = join(root, 'psql-garbage'); writeFileSync(garbage, '#!/bin/sh\necho maybe\nexit 0\n'); chmodSync(garbage, 0o755);
  for (const psqlPath of [bad, garbage, join(root, 'does-not-exist')]) {
    const r = run({ args: ['-c', 'select 1'] }, { envFile: envFile([`LOCAL_DB_RO_URL=${URL_OK}`]), psqlPath });
    assert.equal(r.status, 2, psqlPath);
    assert.match(r.stderr, /could not verify/);
  }
});

test('read-only calls prefer LOCAL_DB_RO_URL when set; --write and --var keep their own variable', () => {
  const vars = [`LOCAL_DB_URL=${mk('localhost:5432', { user: 'rw_user' })}`, `LOCAL_DB_RO_URL=${mk('localhost:5432', { user: 'ro_user' })}`];
  assert.match(ok(['-c', 'select 1'], {}, vars).stdout, /PGUSER=ro_user/);
  assert.match(ok(['-c', 'select 1'], { write: true }, vars).stdout, /PGUSER=rw_user/);
  assert.match(ok(['-c', 'select 1'], { varName: 'LOCAL_DB_URL' }, vars).stdout, /PGUSER=rw_user/);
});

test('--db replaces the database in the URL', () => {
  assert.match(ok(['-c', 'select 1'], { db: 'other_db' }).stdout, /PGDATABASE=other_db/);
  assert.match(refusedMessage(['-c', 'select 1'], { db: 'x; drop database y' }), /bad database name/);
  assert.match(refusedMessage(['-c', 'select 1'], { db: `${SCHEME}prod/x` }), /bad database name/);
});

test("the caller's own PG* variables are dropped", () => {
  const saved = { ...process.env };
  process.env.PGHOST = 'prod.example.com'; process.env.PGSERVICE = 'prod'; process.env.PGOPTIONS = '-c default_transaction_read_only=off';
  try {
    const r = ok(['-c', 'select 1']);
    assert.match(r.stdout, /PGHOST=localhost /);
    assert.match(r.stdout, /PGSERVICE=\[\]/);
    assert.match(r.stdout, /PGOPTIONS=\[-c default_transaction_read_only=on\]/);
  } finally { for (const k of ['PGHOST', 'PGSERVICE', 'PGOPTIONS']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});

test('connection arguments and URIs are refused', () => {
  const uri = [SCHEME, 'x/y'].join('');
  for (const args of [['-h', 'prod'], ['-p', '5438'], ['-U', 'x'], ['-d', uri], ['--host=prod'], ['-P', 'pager=sh'], ['-o', '/tmp/x'], [uri], ['host=prod dbname=x'], ['-W'], ['-L', '/tmp/log'], ['-c']]) {
    assert.match(refusedMessage(args), /not allowed|needs a value/, args.join(' '));
  }
});

test('backslash commands that reconnect, shell out or include files are refused', () => {
  for (const sql of ['\\c prod', '\\connect host=prod', '\\! env', '\\i /tmp/x.sql', '\\ir x', "\\copy t to program 'sh'", '\\setenv A b', '\\set X `id`', 'select 1; \\c prod', '\\dt \\! id', '\\o /tmp/leak', '\\g |sh', 'select `id`', 'select 1 as a$x$ \\! id', 'select a$$ \\! id']) {
    assert.match(refusedMessage(['-c', sql]), /not allowed/, sql);
  }
});

test('catalog and display commands, and backslashes inside quotes, are allowed', () => {
  for (const sql of ['\\dt', '\\d+ some_table', '\\dn', '\\l', '\\x', '\\timing', "select 'a\\c b'", "select E'it\\'s'", 'select $$ \\! $$', '-- \\c prod\nselect 1', '/* \\! */ select 1', 'select "\\c"']) {
    assert.equal(unsafeMeta(sql), undefined, sql);
  }
  assert.equal(ok(['-c', '\\dt']).status, 3);
});

test('-f, -v and stdin scripts are refused: SQL comes from -c only', () => {
  const f = join(root, 's.sql'); writeFileSync(f, 'select 1;\n');
  for (const args of [['-f', f], ['--file', f], ['-f', '-'], ['-v', 'ECHO=all', '-c', 'select 1'], ['--set=ECHO=all'], ['--variable', 'X=1']]) {
    assert.match(refusedMessage(args), /not allowed/, args.join(' '));
  }
  assert.match(refusedMessage([]), /pass the SQL with -c/);
  assert.match(refusedMessage(['-A', '-t']), /pass the SQL with -c/);
  assert.match(refusedMessage(['-c', '\\dt $$ \\! id $$']), /not allowed/);
  assert.match(refusedMessage(['-c', '\\dt /* \\! id */']), /not allowed/);
});

test('server-side file, program and cross-database access is refused in both modes', () => {
  for (const sql of ["select pg_read_file('/x')", "select pg_ls_dir('.')", "select lo_import('/x')", "copy t to program 'sh'", 'COPY t FROM stdin', "select dblink('a','b')", 'select pg_stat_file(1)']) {
    for (const write of [false, true]) assert.match(refusedMessage(['-c', sql], { write }), /server-side file/, sql);
  }
  assert.equal(ok(['-c', 'select copy_id from t']).status, 3);
});

test('env file parsing: export, quotes and comments; nothing is sourced', () => {
  const f = envFile(['# comment', 'export OTHER=1', `LOCAL_DB_URL="${URL_OK}"`, '$(touch /tmp/should-not-exist-localdb)']);
  assert.equal(readEnvValue(f, 'LOCAL_DB_URL'), URL_OK);
  assert.equal(existsSync('/tmp/should-not-exist-localdb'), false);
  assert.equal(readEnvValue(envFile([`LOCAL_DB_URL='${URL_OK}'  # note`]), 'LOCAL_DB_URL'), URL_OK);
  assert.equal(readEnvValue(envFile([`LOCAL_DB_URL=${URL_OK} # note`]), 'LOCAL_DB_URL'), URL_OK);
  assert.throws(() => readEnvValue(f, 'MISSING_ONE'), LocalDbRefused);
  assert.throws(() => readEnvValue(f, 'bad name;'), LocalDbRefused);
  assert.throws(() => readEnvValue(join(root, 'nope', '.env'), 'X'), LocalDbRefused);
  assert.throws(() => parseLocalUrl('LOCAL_DB_URL', 'not a url'), (e: Error) => !e.message.includes('not a url'));
  assert.doesNotThrow(() => plan({ args: ['-c', 'select 1'] }, { envFile: f }));
});

test('CLI: refuses a non-local host with exit 2 and no URL in the output; --info prints no credentials; --help works', () => {
  const home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'dev-env'));
  const cli = (args: string[], url: string) => {
    writeFileSync(join(home, 'dev-env', '.env'), `LOCAL_DB_URL=${url}\n`);
    return spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' });
  };
  const bad = cli(['-c', 'select 1'], mk('db.example.com:5432'));
  assert.equal(bad.status, 2);
  assert.ok(!(bad.stdout + bad.stderr).includes(PASSWORD) && !(bad.stdout + bad.stderr).includes('db.example.com'));
  assert.equal(cli(['--info'], mk('localhost:5438')).status, 2);
  const info = cli(['--info', '--db', 'x_db'], URL_OK);
  assert.equal(info.status, 0);
  assert.equal(info.stdout.trim(), 'host=localhost port=5432 database=x_db mode=read-only');
  assert.ok(!(info.stdout + info.stderr).includes(PASSWORD));
  assert.match(cli(['--help'], URL_OK).stdout, /usage: local-db/);
});

const GUARD = join(homedir(), '.claude/hooks/secret-file-guard.mjs');
test('the secret-file guard still blocks reading env files and lets the helper through', { skip: !existsSync(GUARD) }, () => {
  const verdict = (command: string): number => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' }).status ?? -1;
  for (const blocked of ['cat .env', 'grep LOCAL_DB_URL .env', 'source .env && psql "$LOCAL_DB_URL"', 'cat ssm-prod.json']) assert.equal(verdict(blocked), 2, blocked);
  for (const allowed of ['local-db -c "select count(*) from t"', 'local-db --db fake_db --write -c "update t set a = 1"', 'local-db --info']) assert.equal(verdict(allowed), 0, allowed);
});
