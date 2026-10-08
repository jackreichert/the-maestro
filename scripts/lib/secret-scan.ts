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
}

interface Rule {
    name: string;
    class: FindingClass;
    pattern: RegExp;
    /** Extra test on a match; return false to ignore it. */
    accept?: (match: RegExpExecArray, opts: ScanOptions) => boolean;
}

/** Values that stand for "a value goes here", so `PASSWORD=<redacted>` and `token=$TOKEN` name a variable without leaking one. */
const PLACEHOLDER = /^(?:<[^>]*>|\$\{?\w+\}?|\{\{.*\}\}|\*+|x{3,}|\.{3}|…|redacted|changeme|example|placeholder|none|null|true|false)$/i;
const unquote = (v: string): string => v.replace(/^["'`]+|["'`,;)\]]+$/g, '');
const isValue = (v: string | undefined): boolean => !PLACEHOLDER.test(unquote(v ?? ''));
const hasLetterAndDigit = (v: string): boolean => /[A-Za-z]/.test(v) && /\d/.test(v);

/** Preceded by anything but a letter or digit, so `db_password=` and `access-token:` match as well as `password=`. */
const SECRET_NAME = '(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth(?:orization)?|credentials?|client[_-]?secret)';

/** Rules run in order; every match of every rule is reported. */
const RULES: Rule[] = [
    { name: 'private-key-block', class: 'secret', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
    { name: 'aws-access-key-id', class: 'secret', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
    { name: 'github-token', class: 'secret', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
    { name: 'slack-token', class: 'secret', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { name: 'api-key-prefix', class: 'secret', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g },
    { name: 'jwt', class: 'secret', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    {
        // scheme://user:password@host covers database DSNs and URLs with embedded credentials.
        name: 'url-credentials', class: 'secret', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi,
        accept: (m) => isValue(m[1]),
    },
    {
        // An all-caps environment variable name that ends in a secret word, then `=` and a value.
        name: 'env-name-value', class: 'secret', pattern: /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)\s*=\s*(\S+)/g,
        accept: (m) => isValue(m[1]),
    },
    {
        // A secret word, `=`, and a value that is not a placeholder.
        name: 'secret-assignment', class: 'secret', pattern: new RegExp(`(?<![A-Za-z0-9])${SECRET_NAME}["']?\\s*=\\s*["']?([^\\s"']{4,})`, 'gi'),
        accept: (m) => isValue(m[1]),
    },
    {
        // `password: Abc12345` or `"token": "..."`. Prose such as "token: the value" has no digit, so it passes.
        name: 'secret-colon-value', class: 'secret', pattern: new RegExp(`(?<![A-Za-z0-9])${SECRET_NAME}["']?\\s*:\\s*["']?([^\\s"']{8,})`, 'gi'),
        accept: (m) => hasLetterAndDigit(unquote(m[1] ?? '')) && isValue(m[1]),
    },
    {
        // A long unbroken mixed-case token with a digit. A git sha (lowercase hex) has no capitals, so it passes.
        name: 'high-entropy-blob', class: 'secret', pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g,
        accept: (m) => /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]) && /\d/.test(m[0]),
    },
    { name: 'ssn', class: 'phi', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
    { name: 'phone-number', class: 'phi', pattern: /(?<![\d-])(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\d-])/g },
    {
        name: 'email-address', class: 'phi', pattern: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g,
        accept: (m, opts) => !(opts.allowedEmailDomains ?? []).some((d) => d.toLowerCase() === (m[1] ?? '').toLowerCase()),
    },
    { name: 'date-of-birth', class: 'phi', pattern: /\b(?:dob|d\.o\.b\.?|date of birth|birth ?date|born(?: on)?)\b[^\n]{0,12}?\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/gi },
    { name: 'medical-record-number', class: 'phi', pattern: /\b(?:mrn|medical record (?:number|no\.?))\b\s*[:#=]?\s*[A-Za-z0-9-]{4,}/gi },
];

/** Every finding in `text`, in rule order. Each scan builds fresh regexes, so no lastIndex state leaks between calls. */
export function scanText(text: string, opts: ScanOptions = {}): Finding[] {
    const out: Finding[] = [];
    for (const rule of RULES) {
        for (const m of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
            if (rule.accept && !rule.accept(m, opts)) continue;
            out.push({ rule: rule.name, class: rule.class, index: m.index ?? 0 });
        }
    }
    return out;
}

/** Scans each named field; findings carry the field name so a refusal can say where, without saying what. */
export function scanFields(fields: Readonly<Record<string, string | undefined>>, opts: ScanOptions = {}): FieldFinding[] {
    return Object.entries(fields).flatMap(([field, text]) => (text ? scanText(text, opts).map((f) => ({ ...f, field })) : []));
}

/** One line per finding for an error message: field, rule and class, never the text. */
export const describeFindings = (findings: readonly FieldFinding[]): string[] =>
    findings.map((f) => `${f.field}: looks like ${f.class === 'secret' ? 'a secret' : 'PHI'} (${f.rule})`);
