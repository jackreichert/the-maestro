/**
 * json-out.ts: the one way a script prints `--json` output. Every producer calls `printJson`, so a rule about what may appear in JSON is
 * applied once, here, and a new `--json` flag is covered by using the same call.
 */

/** Prints the value as indented JSON on stdout. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
