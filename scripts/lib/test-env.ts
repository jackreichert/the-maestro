/**
 * The environment a test gives a spawned maestro script (loop-supervisor.ts, event-loop.ts, ...). It is built from nothing, not from
 * `process.env`, so no real user config, event directory or notify command can reach the child: HOME is a temp directory, the user
 * config file is disabled, the event directory is a temp one, and `MAESTRO_NOTIFY_COMMAND` is a stub that only records its calls.
 * A test that really needs something from the outer environment must name it in `extra`; none does today.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Outer variables a spawned script may still see: how to find programs, and temp and locale settings. Nothing that names a maestro setting. */
const PASS_THROUGH = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_COMPILE_CACHE', 'GIT_ALLOW_PROTOCOL'];
/** Set in every clean env: the file the notify stub appends to, one line per call. */
export const NOTIFY_LOG_VAR = 'MAESTRO_TEST_NOTIFY_LOG';

/** A notify stub: a shell script that appends its arguments to `log` and exits 0. It is run as `/bin/sh <script>`, so it never needs the exec bit (the first exec of a new script can take minutes under macOS provenance checks). Returns the argv. */
export function notifyStub(dir: string, log: string): string[] {
  const script = join(dir, 'notify-stub.sh');
  writeFileSync(script, `printf '%s\\n' "$*" >> '${log}'\n`);
  return ['/bin/sh', script];
}

/** A clean env for a spawned maestro script; `extra` wins over the defaults. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-test-env-'));
  const log = join(dir, 'notify-calls.log');
  const env: NodeJS.ProcessEnv = {
    HOME: join(dir, 'home'),
    MAESTRO_LOCAL_CONFIG: '',
    MAESTRO_EVENT_DIR: join(dir, 'events'),
    MAESTRO_NOTIFY_COMMAND: JSON.stringify(notifyStub(dir, log)),
    [NOTIFY_LOG_VAR]: log,
  };
  for (const name of PASS_THROUGH) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

/** The lines the stub recorded for `env`: empty when it was never called. */
export function notifyCalls(env: NodeJS.ProcessEnv): string[] {
  const log = env[NOTIFY_LOG_VAR];
  return log && existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}
