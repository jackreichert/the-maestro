/**
 * withhold.ts: the one place that turns a block of printed text into text that is safe to become session context. Every line the secret
 * scan flags is replaced by a marker, so a secret-shaped stream name or id that a board printed is never echoed.
 */
import { scanText } from './library/scan.ts';
import { neutralise } from './library/safe-text.ts';
import { scanText as scanShared } from './secret-scan.ts';

export const WITHHELD = '[withheld: secret shape]';

/** Shared-scanner rules left out: bare hex and long blobs are what a commit sha or a path looks like when it stands alone in a field. */
const NOT_ALONE = new Set(['hex-key', 'high-entropy-blob']);

/**
 * True when the text has a secret shape. It is scanned as written and again normalised (`neutralise`: zero-width and control characters
 * dropped), and the shared scanner also reads it with whitespace removed, so a token split by a zero-width character or a space is seen.
 * Only a yes or no leaves here; the caller replaces the original text, never a normalised copy.
 */
export function secretShaped(text: string): boolean {
  return scanText(text).length > 0
    || scanText(neutralise(text)).length > 0
    || scanShared(text).some((f) => f.class === 'secret' && !NOT_ALONE.has(f.rule));
}

/** The body with every line the secret scan flags replaced by a marker. */
export function withhold(body: string): string {
  return body.split('\n').map((l) => (secretShaped(l) ? WITHHELD : l)).join('\n');
}
