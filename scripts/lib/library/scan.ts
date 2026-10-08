/**
 * The secret and PHI scan for library pages. The interface is the seam: `Scanner` takes text and returns where it hit, never what it matched,
 * so a hit can be printed without printing the secret. This pattern list is library-check's own floor; it is meant to be swapped for the shared
 * scanner module once that exists, by passing a different `Scanner` to `checkPage` (nothing else here depends on the patterns).
 * Patterns are shapes, not proof: a clean scan does not mean a page is safe, only that none of these shapes appear.
 */
export interface Hit { rule: string; line: number }
export type Scanner = (text: string) => Hit[];

/** A value that is a placeholder (`<password>`, `$VAR`, `{{x}}`, `***`) is not a secret. */
const VALUE = '(?![<$*{])';
const SECRET_WORDS = '(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|PASS)';

export const PATTERNS: readonly { rule: string; re: RegExp }[] = [
  { rule: 'secret:private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'secret:aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'secret:github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { rule: 'secret:slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'secret:api-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { rule: 'secret:jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { rule: 'secret:bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { rule: 'secret:url-credentials', re: new RegExp(`\\b[a-z][a-z0-9+.-]*://[^\\s:/@]+:${VALUE}[^\\s@/]{3,}@`, 'i') },
  { rule: 'secret:env-assignment', re: new RegExp(`\\b[A-Z][A-Z0-9_]*${SECRET_WORDS}\\s*[=:]\\s*["']?${VALUE}[^\\s"']{6,}`) },
  { rule: 'secret:named-value', re: new RegExp(`\\b(?:password|passwd|secret|token|api[_-]?key)\\s*[=:]\\s*["']?${VALUE}[^\\s"',;)]{8,}`, 'i') },
  { rule: 'phi:email', re: /\b[\w.+-]+@(?!example\.(?:com|org)\b)[\w-]+\.[\w.-]+\b/ },
  { rule: 'phi:phone', re: /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/ },
  { rule: 'phi:ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { rule: 'phi:birth-date', re: /\b(?:dob|date of birth|born)\b\s*[:=]?\s*\d/i },
];

/** Scans line by line and reports each line once per rule that matches it. */
export const scanText: Scanner = (text) => text.split('\n').flatMap((line, i) => PATTERNS.filter((p) => p.re.test(line)).map((p): Hit => ({ rule: p.rule, line: i + 1 })));
