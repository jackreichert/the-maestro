/**
 * Log rotation for the supervisor's log. launchd holds that file open (StandardOutPath and StandardErrorPath), so renaming it would leave
 * launchd writing to the renamed file; instead the contents are copied to `<log>.1` (replacing the older one) and the file is truncated
 * in place. launchd opens its output files for appending, so its next write lands at the new start. One old file is kept.
 */
import { copyFileSync, statSync, truncateSync } from 'node:fs';

/** Rotate once the log passes this many bytes. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Rotates `file` when it is over `maxBytes`. Returns whether it did. Never throws: a log that cannot be rotated must not stop the supervisor. */
export function rotateLog(file: string, maxBytes: number = LOG_MAX_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    return true;
  } catch { return false; }
}
