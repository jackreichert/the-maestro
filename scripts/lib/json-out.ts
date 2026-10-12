/**
 * json-out.ts: the one way a script prints `--json` output. Every producer calls `printJson`, so the secret withhold scan that covers printed
 * text (`withhold.ts`) covers JSON too, and a new `--json` flag is covered by using the same call. A string value or object key the scan flags is
 * replaced in place by the withheld marker, so the output keeps its shape and still parses.
 */
import { WITHHELD, secretPair, secretShaped } from './withhold.ts';

const flagged = secretShaped;   // as written, normalised and whitespace-squeezed: see withhold.ts

/** The value with every secret-shaped string (and object key) replaced by the withheld marker; structure, numbers and booleans are untouched. */
export function withholdJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? value : walk(JSON.parse(text));
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return flagged(value) ? WITHHELD : value;
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);   // no prototype: `key in out` must not see `toString` or `constructor`
    for (const [k, v] of Object.entries(value)) {
      const keyFlagged = flagged(k);
      let key = keyFlagged ? WITHHELD : k;
      for (let n = 2; Object.hasOwn(out, key); n += 1) key = `${WITHHELD} ${n}`;
      out[key] = typeof v === 'string' && !keyFlagged && secretPair(k, v) ? WITHHELD : walk(v);   // a string is also read with its key, as `key: value` on one line, by the shared secret rules only (see `secretPair`)
    }
    return { ...out };   // back to an ordinary object for callers; spread defines each key as an own property, `__proto__` included
  }
  return value;
}

/** Prints the value as indented JSON on stdout (one line with `compact`), with secret-shaped strings withheld. */
export function printJson(value: unknown, opts: { compact?: boolean } = {}): void {
  console.log(JSON.stringify(withholdJson(value), null, opts.compact ? undefined : 2));
}
