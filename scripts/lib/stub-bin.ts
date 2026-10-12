/**
 * Test support: write a stub executable (a fake `gh`, `git`, loop binary) that a spawned process runs.
 * Every test that needs one goes through `writeStub`, so how a stub gets executed lives in one place.
 *
 * The first run of any newly written executable stalls for 76-87 s on macOS (a scan of new executables), which times
 * out tests under load. So the stub's script is written as a plain, non-executable `<path>.stub`, and `<path>` is a
 * symlink to the committed `stub-runner.sh`, which runs the script through the interpreter on its shebang line.
 * Nothing newly written is ever executed.
 */
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./stub-runner.sh', import.meta.url));

/** Writes `body` (a script whose first line is `#!<one interpreter>`, no arguments) behind an executable `path`, and returns `path`. */
export function writeStub(path: string, body: string): string {
  if (!/^#![^\s]+\n/.test(body)) throw new Error('a stub needs a first line of `#!<interpreter>` with no arguments');
  writeFileSync(`${path}.stub`, body);
  rmSync(path, { force: true });
  symlinkSync(RUNNER, path);
  return path;
}
