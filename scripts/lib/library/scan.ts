/**
 * The secret and PHI scan for library pages. The interface is the seam: `Scanner` takes text and returns where it hit, never what it matched,
 * so a hit can be printed without printing the secret. This pattern list is library-check's own floor; it is meant to be swapped for the shared
 * scanner module once that exists, by passing a different `Scanner` to `checkVault` (nothing else here depends on the patterns).
 * Patterns are shapes, not proof: a clean scan does not mean a page is safe, only that none of these shapes appear.
 * A line longer than MAX_LINE is not scanned by pattern (the patterns are quadratic on long lines) and is reported instead, so it fails closed.
 */
export interface Hit { rule: string; line: number }
export type Scanner = (text: string) => Hit[];

export const MAX_LINE = 4000;

/** A value that only stands for one: `<password>`, `$VAR`, `${VAR}`, `{{x}}`, `***`. */
const PLACEHOLDER = /^(?:<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{.*\}\}|\*{3,}|x{3,}|redacted)$/i;
/** What may follow the key word before the separator: a plural or a short qualifier (`secret_key`), not a longer word (`secret-file-guard.mjs`, `credentialing`). */
const SUFFIX = '(?:s|[_-](?:key|id|value|secret|token|pass|password))?';
const KEY = '(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credentials?)';
/** key, optional quotes, `=` or `:`, then a quoted value (spaces allowed) or a bare one. */
const KEY_VALUE = new RegExp(`(?:^|[^A-Za-z0-9])["']?[\\w.-]*${KEY}${SUFFIX}["']?\\s*[=:]\\s*(?:"(?<q>[^"]{6,})"|'(?<s>[^']{6,})'|(?<b>[^\\s"',;)\u0060]{6,}))`, 'i');
/** a key with its value on the next line (`password:` or `password: |`). */
const KEY_ONLY = new RegExp(`(?:^|[^A-Za-z0-9])["']?[\\w.-]*${KEY}${SUFFIX}["']?\\s*[=:]\\s*[|>]?[+-]?\\s*$`, 'i');
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]*:(?<v>[^\s@/]{3,})@/i;

export const PATTERNS: readonly { rule: string; re: RegExp }[] = [
  { rule: 'secret:private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'secret:aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'secret:github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { rule: 'secret:slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'secret:slack-webhook', re: /hooks\.slack\.com\/services\//i },
  { rule: 'secret:api-key', re: /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36})/ },
  { rule: 'secret:jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { rule: 'secret:auth-header', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { rule: 'phi:email', re: /(?<![\w.+-])[\w.+-]{1,64}@(?!example\.(?:com|org)\b)[\w-]+\.[\w.-]+\b/ },
  { rule: 'phi:phone', re: /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b|\+\d{10,}/ },
  { rule: 'phi:ssn', re: /\b\d{3}[- ]\d{2}[- ]\d{4}\b|\bssn\b\W{0,3}\d{9}\b/i },
  { rule: 'phi:birth-date', re: /\b(?:dob|date[_ ]of[_ ]birth|birth[_ ]?date|born)\b["']?\s*[:=]?\s*\d/i },
];

/**
 * A bare token that looks random: 32 or more characters of the base64 and base62 alphabet (so no `.`, `:` or spaces, which rules out URLs and file
 * names) that pass two tests. (1) At least 4.2 bits of Shannon entropy per character: git shas, md5/sha256 digests and UUIDs are hex, which cannot
 * reach 4 bits, so they pass. (2) Letters and digits swap class (lower, upper, digit) at least 45% of the time between neighbours: random base62
 * swaps about 62% of the time, while words, camelCase identifiers, vault paths and slugs swap 0 to 35%, so they pass even when they are long.
 * Cost: a hex secret of any length reads as a sha; a token split by a `.` or `:` is not seen; a few in 100 random 32-character tokens (fewer
 * at 64 and more) swap too rarely to be caught. A floor, as the module note says.
 */
const TOKEN_MIN = 32;
const TOKEN_ENTROPY = 4.2;
const TOKEN_SWAPS = 0.45;
const TOKEN = /^[A-Za-z0-9+/_=-]+$/;
function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  return -[...n.values()].reduce((h, k) => h + (k / s.length) * Math.log2(k / s.length), 0);
}
const charClass = (c: string): number => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3);
/** Share of neighbouring letter or digit pairs whose class (lower, upper, digit) differs. */
function classSwaps(s: string): number {
  let pairs = 0;
  let swaps = 0;
  for (let i = 1; i < s.length; i += 1) {
    const a = charClass(s[i - 1] as string);
    const b = charClass(s[i] as string);
    if (a < 3 && b < 3) { pairs += 1; if (a !== b) swaps += 1; }
  }
  return pairs ? swaps / pairs : 0;
}
const looksRandom = (token: string): boolean => token.length >= TOKEN_MIN && TOKEN.test(token) && entropy(token) >= TOKEN_ENTROPY && classSwaps(token) >= TOKEN_SWAPS;
/** Lines holding a whitespace-delimited word that looks random once the punctuation around it (quotes, brackets, backticks, a trailing stop) is trimmed. */
function randomTokenHits(lines: string[]): Hit[] {
  return lines.flatMap((line, i): Hit[] => (line.split(/\s+/).some((w) => looksRandom(w.replace(/^[^A-Za-z0-9+/_=-]+|[^A-Za-z0-9+/_=-]+$/g, ''))) ? [{ rule: 'secret:high-entropy', line: i + 1 }] : []));
}

const isReal = (v: string | undefined): boolean => v !== undefined && !PLACEHOLDER.test(v.trim());

/** Lines that hold a key=value secret shape (including a key whose value is on the next non-blank line) or credentials in a URL. */
function keyValueHits(lines: string[]): Hit[] {
  const hits: Hit[] = [];
  lines.forEach((line, i) => {
    const m = KEY_VALUE.exec(line);
    if (m && isReal(m.groups?.q ?? m.groups?.s ?? m.groups?.b)) hits.push({ rule: 'secret:key-value', line: i + 1 });
    else if (KEY_ONLY.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      const value = next?.trim().replace(/^["']|["']$/g, '') ?? '';
      if (value.length >= 6 && isReal(value) && !/^[-#]?\s*[\w.-]+:\s*\S*$/.test(value)) hits.push({ rule: 'secret:key-value', line: i + 1 });
    }
    const u = URL_USERINFO.exec(line);
    if (u && isReal(u.groups?.v)) hits.push({ rule: 'secret:url-credentials', line: i + 1 });
  });
  return hits;
}

/** Scans line by line and reports each line once per rule that matches it. */
export const scanText: Scanner = (text) => {
  const lines = text.split('\n');
  const long = lines.flatMap((l, i): Hit[] => (l.length > MAX_LINE ? [{ rule: 'scan:line-too-long', line: i + 1 }] : []));
  const short = lines.map((l) => (l.length > MAX_LINE ? '' : l));
  const byPattern = short.flatMap((line, i) => PATTERNS.filter((p) => p.re.test(line)).map((p): Hit => ({ rule: p.rule, line: i + 1 })));
  return [...long, ...byPattern, ...keyValueHits(short), ...randomTokenHits(short)];
};
