/**
 * Test support: a stand-in for a tool the code under test spawns (a fake `gh`, `git`, loop binary).
 *
 * macOS stalls the first run of any newly written executable for minutes, and git writes a committed script fresh into
 * every new checkout, so nothing on the test path may execute a file that a test or a checkout wrote. A stub is
 * therefore a plain, non-executable script that an interpreter already on the machine runs: `writeStub` writes the
 * script and returns the interpreter plus script, and `stubEnv` turns that into the env pair the code under test
 * reads (`X` and `X_ARGS`, see tool-bin.ts). The interpreter comes from the script's own `#!` line.
 */
import { writeFileSync } from 'node:fs';

/** The only interpreters a stub may name; all exist on the machine already, so running one never waits on a scan. */
const INTERPRETERS = [process.execPath, '/bin/sh', '/bin/bash'];

export interface Stub { script: string; bin: string; args: string[] }

/** Writes `body` (a script whose first line is `#!` plus node's path, /bin/sh or /bin/bash) to `path`, not executable. */
export function writeStub(path: string, body: string): Stub {
  const bin = /^#!([^\s]+)\n/.exec(body)?.[1];
  if (!bin || !INTERPRETERS.includes(bin)) throw new Error(`a stub's first line must be #! plus one of ${INTERPRETERS.join(', ')}, with no arguments`);
  writeFileSync(path, body);
  return { script: path, bin, args: [path] };
}

/** The env entries that make `varName` (for example MAESTRO_GH_BIN) run `stub`. */
export const stubEnv = (varName: string, stub: Stub): Record<string, string> => ({ [varName]: stub.bin, [`${varName}_ARGS`]: JSON.stringify(stub.args) });
