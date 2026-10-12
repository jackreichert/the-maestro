/**
 * json-out.ts: the one way a script prints `--json` output. Every producer calls `printJson`, so the secret withhold scan that covers printed
 * text (`withhold.ts`) covers JSON too, and a new `--json` flag is covered by using the same call. A string value or object key the scan flags is
 * replaced in place by the withheld marker, so the output keeps its shape and still parses.
 */
import { WITHHELD } from './withhold.ts';
import { scanText } from './library/scan.ts';

const flagged = (s: string): boolean => scanText(s).length > 0;

/** The value with every secret-shaped string (and object key) replaced by the withheld marker; structure, numbers and booleans are untouched. */
export function withholdJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? value : walk(JSON.parse(text));
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return flagged(value) ? WITHHELD : value;
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      let key = flagged(k) ? WITHHELD : k;
      for (let n = 2; key in out; n += 1) key = `${WITHHELD} ${n}`;
      out[key] = walk(v);
    }
    return out;
  }
  return value;
}

/** Prints the value as indented JSON on stdout, with secret-shaped strings withheld. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(withholdJson(value), null, 2));
}
