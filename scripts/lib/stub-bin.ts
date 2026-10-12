/**
 * Test support: write a stub executable (a fake `gh`, `git`, loop binary) that a spawned process runs.
 * Every test that needs one goes through `writeStub`, so how a stub gets executed lives in one place.
 */
import { chmodSync, writeFileSync } from 'node:fs';

/** Writes `body` (a script with a shebang) to `path`, marks it executable and returns `path`. */
export function writeStub(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}
