/**
 * Secret and PHI scanner: refuses text that carries the shape of a credential or of patient data. Shared by
 * everything that writes free text into a durable place (`journal.ts learned` today; the library write path next).
 *
 * Pure and offline. It reports which rule matched and where, never the matched text, so a finding is safe to print
 * and to log. Pattern matching cannot prove text is clean: a clean result means "no known shape", not "safe". PHI
 * in particular is only caught where it has a fixed shape (dates of birth, SSNs, phones, emails, MRNs), so the
 * caller's field design (systems, ids and counts only) still does most of the work.
 */

/** What a rule looks for: a credential or protected health information. */
export type FindingClass = 'secret' | 'phi';

/** One match: the rule that fired, its class, and the offset in the scanned text. Never the matched text. */
export interface Finding { rule: string; class: FindingClass; index: number }

/** A finding that also names the field it came from. */
export interface FieldFinding extends Finding { field: string }

export interface ScanOptions {
    /** Email domains that may appear (for example a documentation domain); compared case-insensitively with the part after the `@`. */
    allowedEmailDomains?: readonly string[];
    /** Fields (for `scanFields`) whose whole value may be a bare 40-hex git sha, because the field is where a sha belongs (`verified-at`). */
    shaFields?: readonly string[];
}

interface Rule {
    name: string;
    class: FindingClass;
    pattern: RegExp;
    /** Extra test on a match; return false to ignore it. */
    accept?: (match: RegExpExecArray, opts: ScanOptions) => boolean;
    /**
     * For a credential with a distinctive prefix: the same shape without word boundaries, matched against the text with
     * all whitespace removed, so a key split by a space or a line break (or across fields) is still seen. Only prefixes
     * that do not occur in prose belong here, since joining words can make anything.
     */
    squeezed?: RegExp;
}

/** Values that stand for "a value goes here", so `PASSWORD=<redacted>` and `token=$TOKEN` name a variable without leaking one. */
const PLACEHOLDER = /^(?:<[^>]*>|\$\{?\w+\}?|\{\{.*\}\}|\*+|x{3,}|\.{3}|…|redacted|changeme|example|placeholder|none|null|true|false)$/i;
const unquote = (v: string): string => v.replace(/^["'`]+|["'`,;)\]]+$/g, '');
const isValue = (v: string | undefined): boolean => !PLACEHOLDER.test(unquote(v ?? ''));
const hasLetterAndDigit = (v: string): boolean => /[A-Za-z]/.test(v) && /\d/.test(v);
/** A value after `name:`: a letter and a digit, or (for a password name only) a single word of 12 or more letters. */
const looksLikeValue = (name: string | undefined, raw: string | undefined): boolean => {
    const v = unquote(raw ?? '');
    if (!isValue(raw)) return false;
    return hasLetterAndDigit(v) || (/^pass|^pwd/i.test(name ?? '') && /^[A-Za-z]{12,}$/.test(v));
};

/**
 * True for a run that is a path, URL tail or hyphenated name rather than a blob: it has at least three `/`, `_` or `-`
 * separators, no `+` or `=` (base64 padding and alphabet), and no word between separators that looks random (12 or more
 * characters, both cases, and a digit anywhere but the end, so `PolicyName2` is a word and `aB3dE6gH9jK2` is not).
 * Credentials in a URL (`user:pass@`, `?token=`) are caught by their own rules before this one is asked.
 * Residual risk, accepted: a random token whose every run between separators is under 12 characters passes.
 */
function isStructuredName(token: string): boolean {
    if (/[+=]/.test(token) || (token.match(/[/_-]/g)?.length ?? 0) < 3) return false;
    return !token.split(/[/_-]+/).some((w) => w.length >= 12 && /[a-z]/.test(w) && /[A-Z]/.test(w) && /\d/.test(w.replace(/\d+$/, '')));
}

/** The 24 characters before a match, to see what labels it. */
const before = (m: RegExpExecArray): string => m.input.slice(Math.max(0, m.index - 24), m.index);
/** What makes a 40-hex value a git sha: a sha, commit, rev, head, merge or verified-at label, an `@`, or a commit, tree or blob URL. */
const SHA_LABEL = /(?:\b(?:sha-?1|sha|commits?|verified[- ]at|rev(?:ision)?|head|merge)\b[\s:=#`'"(]{0,4}|@|\/(?:commits?|tree|blob)\/)$/i;
/** What makes a 64-hex value a digest: a sha256, checksum or digest label. */
const DIGEST_LABEL = /\b(?:sha-?256|checksum|digest)\b[\s:=#`'"(]{0,4}$/i;

/** Preceded by anything but a letter or digit, so `db_password=` and `access-token:` match as well as `password=`. */
const SECRET_NAME = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth(?:orization)?|credentials?|client[_-]?secret)';

/** The ways a date is written: numeric with `-`, `/` or `.`, ISO, `March 3, 1950` and `3 March 1950`. */
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DATE_SHAPES = `\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}`;

/** Rules run in order; every match of every rule is reported. */
const RULES: Rule[] = [
    { name: 'private-key-block', class: 'secret', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
    { name: 'aws-access-key-id', class: 'secret', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, squeezed: /(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}/g },
    { name: 'github-token', class: 'secret', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, squeezed: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
    { name: 'slack-token', class: 'secret', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, squeezed: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
    { name: 'api-key-prefix', class: 'secret', pattern: /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})/g, squeezed: /(?:sk-(?:ant|proj)-[A-Za-z0-9_-]{20,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})/g },
    {
        // 16 or more characters of anything, or 8 or more with a letter and a digit (`Bearer abc123def456`); prose such as "bearer tokens" has no digit.
        name: 'bearer-or-basic-credential', class: 'secret', pattern: /(?<![A-Za-z0-9])(?:bearer|basic)\s+([A-Za-z0-9._~+/-]{8,})=*/gi,
        accept: (m) => (m[1] ?? '').length >= 16 || hasLetterAndDigit(m[1] ?? ''),
    },
    { name: 'npm-token', class: 'secret', pattern: /\bnpm_[A-Za-z0-9]{30,}/g, squeezed: /npm_[A-Za-z0-9]{30,}/g },
    { name: 'jwt', class: 'secret', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, squeezed: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    {
        // scheme://user:password@host covers database DSNs and URLs with embedded credentials.
        name: 'url-credentials', class: 'secret', pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,256}:([^\s@]{1,256})@/gi,
        // A password may contain `/`; `host:8080/path@x` is a port and a path, not a credential.
        accept: (m) => isValue(m[1]) && !/^\d{1,5}(?:\/|$)/.test(m[1] ?? ''),
    },
    {
        // An all-caps environment variable name that ends in a secret word, then `=` and a value.
        name: 'env-name-value', class: 'secret', pattern: /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PASS|CREDENTIALS?)\s*=\s*(\S+)/g,
        accept: (m) => isValue(m[1]),
    },
    {
        // A secret word, `=`, and a value that is not a placeholder.
        name: 'secret-assignment', class: 'secret', pattern: new RegExp(`(?<![A-Za-z0-9])${SECRET_NAME}["']?\\s*=\\s*["']?([^\\s"']{4,})`, 'gi'),
        accept: (m) => isValue(m[1]),
    },
    {
        // `--password hunter2`, `--api-key abc`: a command-line flag that names a secret, then its value.
        name: 'secret-flag', class: 'secret', pattern: /(?<![A-Za-z0-9-])--(?:pass(?:word|wd|phrase)?|pwd|secret|token|api-?key|access-?key|client-?secret|auth-?token)(?:\s+|=)(?!-)(\S+)/gi,
        accept: (m) => isValue(m[1]),
    },
    {
        // `password: Abc12345` or `"token": "..."`. Prose such as "token: the value" has no digit, so it passes; a long
        // single word after a password name (`password: correcthorsebattery`) is a passphrase, not prose.
        name: 'secret-colon-value', class: 'secret', pattern: new RegExp(`(?<![A-Za-z0-9])(${SECRET_NAME})["']?\\s*:\\s*["']?([^\\s"']{6,})`, 'gi'),
        accept: (m) => looksLikeValue(m[1], m[2]),
    },
    {
        // A camelCase name: `dbPassword=...`, `apiKey: ...`. The value must carry a letter and a digit, or be a passphrase.
        name: 'camel-secret-assignment', class: 'secret', pattern: /[a-z](Password|Passwd|Pwd|Secret|Token|ApiKey|AccessKey|PrivateKey|ClientSecret)["']?\s*[=:]\s*["']?([^\s"']{6,})/g,
        accept: (m) => looksLikeValue(m[1], m[2]),
    },
    {
        // A bare hex key. A 40-hex value passes only where it reads as a git sha, a 64-hex value only as a sha256 or checksum.
        name: 'hex-key', class: 'secret', pattern: /(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])/g,
        accept: (m) => !(m[0].length === 40 && SHA_LABEL.test(before(m))) && !(m[0].length === 64 && DIGEST_LABEL.test(before(m))),
    },
    {
        // A long unbroken mixed-case token with a digit. A git sha (lowercase hex) has no capitals, so it passes, and so
        // does a path or a hyphenated name made of readable words (see `isStructuredName`).
        name: 'high-entropy-blob', class: 'secret', pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g,
        accept: (m) => /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]) && /\d/.test(m[0]) && !isStructuredName(m[0]),
    },
    { name: 'ssn', class: 'phi', pattern: /\b\d{3}-\d{2}-\d{4}\b|\b(?:ssn|social security(?: number| no\.?)?)\b\D{0,12}?\b\d{9}\b/gi },
    { name: 'phone-number', class: 'phi', pattern: /(?<![\d-])(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\d-])/g },
    {
        name: 'email-address', class: 'phi', pattern: /\b[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,10})\b/g,
        accept: (m, opts) => !(opts.allowedEmailDomains ?? []).some((d) => d.toLowerCase() === (m[1] ?? '').toLowerCase()),
    },
    { name: 'date-of-birth', class: 'phi', pattern: new RegExp(`\\b(?:dob|d\\.o\\.b\\.?|date of birth|birth ?date|born(?: on)?)\\b[^\\n]{0,12}?\\b(?:${DATE_SHAPES})\\b`, 'gi') },
    { name: 'medical-record-number', class: 'phi', pattern: /\b(?:mrn|medical record (?:number|no\.?))\b\s*[:#=]?\s*[A-Za-z0-9-]{4,}/gi },
];

/** Letters from other scripts that look like a Latin one (Cyrillic and Greek), folded to the Latin letter so they cannot split a shape. */
const CONFUSABLE_PAIRS = [
    'АA', 'ВB', 'ЕE', 'ЅS', 'ІI', 'ЈJ', 'КK', 'МM', 'НH', 'ОO', 'РP', 'СC', 'ТT', 'ХX', 'УY',   // Cyrillic capitals
    'аa', 'еe', 'ѕs', 'іi', 'јj', 'оo', 'рp', 'сc', 'уy', 'хx', 'ԁd',                              // Cyrillic small
    'ΑA', 'ΒB', 'ΕE', 'ΖZ', 'ΗH', 'ΙI', 'ΚK', 'ΜM', 'ΝN', 'ΟO', 'ΡP', 'ΤT', 'ΥY', 'ΧX',         // Greek capitals
    'αa', 'ιi', 'οo', 'νv', 'ρp',                                                                  // Greek small
];
const CONFUSABLES = new Map(CONFUSABLE_PAIRS.map((p) => [p[0] as string, p[1] as string]));
const foldConfusables = (t: string): string => t.replace(/[\u0370-\u03ff\u0400-\u04ff\u0500-\u052f]/g, (c) => CONFUSABLES.get(c) ?? c);

/** Decodes `%XX` escapes of ASCII characters, at most twice (so `%2541` is seen as `A` but nothing loops), leaving the rest as written. */
function decodePercent(t: string): string {
    let out = t;
    for (let pass = 0; pass < 2 && /%[0-7][0-9a-f]/i.test(out); pass++) out = out.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return out;
}

/**
 * What the rules read: fullwidth and compatibility forms folded, zero-width and other format characters dropped,
 * Cyrillic and Greek lookalikes folded to Latin, and `%XX` escapes decoded, so none of them can hide a shape.
 * Offsets in findings refer to this text.
 */
export const normalise = (raw: string): string => decodePercent(foldConfusables(raw.normalize('NFKC').replace(/\p{Cf}/gu, '')));

/** Every finding in `text`, in rule order. Each scan builds fresh regexes, so no lastIndex state leaks between calls. */
export function scanText(raw: string, opts: ScanOptions = {}): Finding[] {
    const text = normalise(raw);
    const out: Finding[] = [];
    for (const rule of RULES) {
        for (const m of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
            if (rule.accept && !rule.accept(m, opts)) continue;
            out.push({ rule: rule.name, class: rule.class, index: m.index ?? 0 });
        }
    }
    // A key split by whitespace: look again, with the whitespace gone, for the rules that allow it. Offsets are in the squeezed text.
    const squeezed = text.replace(/\s+/g, '');
    if (squeezed.length !== text.length) {
        for (const rule of RULES) {
            if (!rule.squeezed || out.some((f) => f.rule === rule.name)) continue;
            const m = new RegExp(rule.squeezed.source, rule.squeezed.flags).exec(squeezed);
            if (m) out.push({ rule: rule.name, class: rule.class, index: m.index });
        }
    }
    return out;
}

/**
 * Scans each named field, then the fields joined, so a value split across fields (`password=` in one and the value in
 * another, or half a key in each) is seen. The joins are all fields in order and every ordered pair of fields (up to
 * 16 fields; a value split three ways is not covered). A finding from a join is reported as field `(fields combined)`
 * and only for a rule that did not already fire on a single field. A field named in `shaFields` that holds just a
 * 40-hex sha is skipped.
 */
export function scanFields(fields: Readonly<Record<string, string | undefined>>, opts: ScanOptions = {}): FieldFinding[] {
    const texts = Object.entries(fields).filter((e): e is [string, string] => !!e[1] && !(opts.shaFields?.includes(e[0]) && /^[0-9a-f]{40}$/.test(e[1].trim())));
    const single = texts.flatMap(([field, text]) => scanText(text, opts).map((f) => ({ ...f, field })));
    if (texts.length < 2) return single;
    const values = texts.map(([, t]) => t);
    const joins = [values.join(' ')];
    if (values.length <= 16) for (const a of values) for (const b of values) if (a !== b) joins.push(`${a} ${b}`);
    const seen = new Set(single.map((f) => f.rule));
    const combined: FieldFinding[] = [];
    for (const text of joins) {
        for (const f of scanText(text, opts)) {
            if (seen.has(f.rule)) continue;
            seen.add(f.rule);
            combined.push({ ...f, field: '(fields combined)' });
        }
    }
    return [...single, ...combined];
}

/** One line per finding for an error message: field, rule and class, never the text. */
export const describeFindings = (findings: readonly FieldFinding[]): string[] =>
    findings.map((f) => `${f.field}: looks like ${f.class === 'secret' ? 'a secret' : 'PHI'} (${f.rule})`);
