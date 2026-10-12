/**
 * withhold.ts: the one place that turns a block of printed text into text that is safe to become session context. Every line the secret
 * scan flags is replaced by a marker, so a secret-shaped stream name or id that a board printed is never echoed.
 */
import { scanText } from './library/scan.ts';

export const WITHHELD = '[withheld: secret shape]';

/** The body with every line the secret scan flags replaced by a marker. */
export function withhold(body: string): string {
  const hits = new Set(scanText(body).map((h) => h.line));
  return hits.size ? body.split('\n').map((l, i) => (hits.has(i + 1) ? WITHHELD : l)).join('\n') : body;
}
