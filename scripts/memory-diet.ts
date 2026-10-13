#!/usr/bin/env node
/**
 * MEMORY DIET: a read-only classifier for fixture text. It does not shrink, move, or delete anything,
 * and it never opens the live skill file or a memory index.
 *
 *   node scripts/memory-diet.ts --fixture <file.md> --comparison <artifact>
 *
 * A section stays when its heading or body is a hard limit, a secret rule, attribution, git safety,
 * or an action-gating rule. Anything else is listed as movable behind `find` or `library-brief`.
 * A heading that says hard limit is never movable, even when the body reads like a lookup table.
 *
 * A shrink recommendation is refused (exit 1, nothing listed, nothing changed) unless `--comparison`
 * is a file that explicitly says the cold-start check passed. A missing, unreadable, or failing
 * artifact is the same refusal. Accepted pass lines, whole line after trim, optional trailing period:
 * `cold-start check passed`, `cold-start check: passed`, `cold-start comparison passed`,
 * `cold-start comparison: passed`, and the checker's own `cold-start check: ok`.
 * A JSON object with `coldStartCheck` (or `check: "cold-start"` plus `result`) of `passed` or `ok`
 * is the same statement. Any cold-start failure line wins over a pass line.
 *
 * Printed text is headings and fixed reasons only. A secret-shaped heading is withheld, never echoed.
 * Exit 0 when the comparison passed and the list was printed. Exit 1 when shrink is refused.
 * Exit 2 on bad usage. This file imports no write API.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WITHHELD, secretShaped, withhold } from './lib/withhold.ts';

const USAGE = 'Usage: memory-diet.ts --fixture <file.md> --comparison <artifact>';

const WRITE_FLAGS = new Set(['--delete', '--shrink', '--apply', '--move', '--write']);

const PASS_LINE = /^(?:cold-start check: ok|cold-start check: passed|cold-start check passed|cold-start comparison: passed|cold-start comparison passed)\.?$/i;
const FAIL_LINE = /^(?:cold-start check: failed\b.*|cold-start check failed\b.*|cold-start comparison: failed\b.*|cold-start comparison failed\b.*)$/i;

/** Heading signals. A hard-limit heading is also forced in `classifySection`, so a later rule cannot reclassify it. */
const HEADING_RULES: readonly { category: string; pattern: RegExp }[] = [
  { category: 'hard limits', pattern: /\bhard[-\s]*limits?\b|\bnon-negotiable\b|\bstanding rules\b/i },
  { category: 'secrets', pattern: /\b(?:secrets?|credentials?|zdr|phi)\b|\.env\b|\bssm-/i },
  { category: 'attribution', pattern: /\battribution\b|co-authored-by|generated with/i },
  { category: 'git safety', pattern: /\bgit safety\b|\bprotected branches?\b|\bforce-push\b|\bauthorship\b/i },
  { category: 'action-gating', pattern: /\baction[-\s]*gating\b|\bgating rules?\b|\bexplicit permission\b|\bask first\b|\bdo not act\b/i },
];

/** Body signals. Narrow on purpose: a lookup section that does not state one of these stays movable. */
const BODY_RULES: readonly { category: string; pattern: RegExp }[] = [
  { category: 'hard limits', pattern: /\bhard[-\s]*limits?\b/i },
  { category: 'secrets', pattern: /\.env\b|\bssm-\*\.json|\b(?:api[_-]?key|password|secret)\s*[:=]/i },
  { category: 'attribution', pattern: /co-authored-by|generated with|\bno ai attribution\b|\battribution\b/i },
  { category: 'git safety', pattern: /\bprotected branches?\b|\bgit safety\b|\bforce-push\b|\bnever write\s+`?main`?/i },
  { category: 'action-gating', pattern: /\bexplicit permission\b|\baction[-\s]*gating\b|\bask first\b|\bdo not act\b|\bnever (?:commit|push|rebase|merge|reset)\b/i },
];

export type Bucket = 'must-stay' | 'movable';
export type ComparisonVerdict = 'passed' | 'failed' | 'unspecified';

export interface ClassifiedSection {
  heading: string;
  line: number;
  bucket: Bucket;
  /** A fixed category name, never a slice of the fixture. */
  category: string;
}

interface Section {
  heading: string;
  line: number;
  body: string;
}

interface Options {
  fixture?: string;
  comparison?: string;
  refuseWrite: boolean;
}

/** True when the heading itself is a hard limit. Body text cannot move it. */
export function isHardLimitHeading(heading: string): boolean {
  return /\bhard[-\s]*limits?\b/i.test(heading);
}

/** Split ATX headings. A heading inside a fence stays body text, so an example cannot become a section. */
export function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  let fence: string | null = null;
  const sections: Section[] = [];
  let current: Section = { heading: '(preamble)', line: 1, body: '' };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fenceMark = /^(```+|~~~+)/.exec(line.trim());
    if (fenceMark) {
      const mark = fenceMark[1] ?? '';
      fence = fence !== null && mark.startsWith(fence.slice(0, 3)) ? null : mark;
      current.body += `${line}\n`;
      continue;
    }
    const heading = fence === null ? /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      sections.push(current);
      current = { heading: (heading[2] ?? '').replace(/\s+#+\s*$/, '').trim(), line: i + 1, body: '' };
    } else {
      current.body += `${line}\n`;
    }
  }
  sections.push(current);
  return sections.filter((section) => section.heading !== '(preamble)' || section.body.trim().length > 0);
}

function categoryOf(rules: readonly { category: string; pattern: RegExp }[], text: string): string | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return null;
}

/** Classify one section. A hard-limit heading stays even when the body looks movable. Secret-shaped text stays and is not echoed. */
export function classifySection(heading: string, body: string): { bucket: Bucket; category: string } {
  if (isHardLimitHeading(heading)) return { bucket: 'must-stay', category: 'hard limits' };
  if (secretShaped(heading) || secretShaped(body)) return { bucket: 'must-stay', category: 'secrets' };
  const fromHeading = categoryOf(HEADING_RULES, heading);
  if (fromHeading) return { bucket: 'must-stay', category: fromHeading };
  const fromBody = categoryOf(BODY_RULES, body);
  if (fromBody) return { bucket: 'must-stay', category: fromBody };
  return { bucket: 'movable', category: 'find or library-brief' };
}

/** Every section of `text`, in document order. */
export function classifyText(text: string): ClassifiedSection[] {
  return splitSections(text).map((section) => {
    const found = classifySection(section.heading, section.body);
    return { heading: section.heading, line: section.line, bucket: found.bucket, category: found.category };
  });
}

function jsonVerdict(text: string): ComparisonVerdict | 'not-json' {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return 'not-json';
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return 'not-json';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not-json';
  const rec = value as Record<string, unknown>;
  const direct = rec.coldStartCheck ?? rec['cold-start-check'];
  const nested = rec.check === 'cold-start' ? rec.result ?? rec.status : undefined;
  const status = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : undefined;
  if (status === undefined) return 'unspecified';
  if (/^(?:passed|ok)$/i.test(status)) return 'passed';
  if (/^fail/i.test(status)) return 'failed';
  return 'unspecified';
}

/**
 * Whether the artifact explicitly says the cold-start check passed.
 * A failure line wins, including when a pass line is also present.
 */
export function comparisonVerdict(text: string): ComparisonVerdict {
  const fromJson = jsonVerdict(text);
  if (fromJson === 'failed') return 'failed';
  let passed = fromJson === 'passed';
  let failed = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (FAIL_LINE.test(trimmed) || (/\bcold-start\b/i.test(trimmed) && /\b(?:failed|did not pass|not passed)\b/i.test(trimmed))) {
      failed = true;
    } else if (PASS_LINE.test(trimmed)) {
      passed = true;
    }
  }
  if (failed) return 'failed';
  if (passed) return 'passed';
  return 'unspecified';
}

function blockedPath(file: string): boolean {
  const parts = file.replaceAll('\\', '/').split('/');
  if (parts.includes('.claude') || parts.includes('memories')) return true;
  const base = basename(file);
  return base === 'private-patterns.txt' || base.startsWith('.env') || /^ssm-.*\.json$/i.test(base);
}

type ReadResult = { ok: true; text: string } | { ok: false; why: 'missing' | 'unreadable' | 'blocked' };

/** Read a caller-supplied file. Refuses secret files and memory indexes without opening them. */
function readSupplied(file: string): ReadResult {
  if (blockedPath(file)) return { ok: false, why: 'blocked' };
  try {
    if (!statSync(file).isFile()) return { ok: false, why: 'unreadable' };
    const text = readFileSync(file, 'utf8');
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    return { ok: false, why: code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function parseArgs(argv: string[]): Options | string {
  let fixture: string | undefined;
  let comparison: string | undefined;
  let refuseWrite = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg !== undefined && WRITE_FLAGS.has(arg)) {
      refuseWrite = true;
      continue;
    }
    if (arg === '--fixture' || arg === '--comparison') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      if (arg === '--fixture') fixture = value;
      else comparison = value;
      i += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith('--')) return `unknown argument ${arg ?? ''}`;
    positional.push(arg);
  }
  if (positional.length > 1) return 'too many arguments';
  return { fixture: fixture ?? positional[0], comparison, refuseWrite };
}

function showHeading(heading: string): string {
  return secretShaped(heading) ? WITHHELD : heading;
}

function listBlock(title: string, rows: ClassifiedSection[]): string {
  const lines = rows.map((row) => `- ${showHeading(row.heading)}`);
  return `${title}:\n${lines.length === 0 ? '(none)' : lines.join('\n')}`;
}

/** The recommendation. Headings only; secret-shaped headings are already withheld. */
export function renderReport(sections: ClassifiedSection[]): string {
  const movable = sections.filter((section) => section.bucket === 'movable');
  const stay = sections.filter((section) => section.bucket === 'must-stay');
  return [
    'memory-diet: cold-start comparison passed',
    'shrink recommendation: list only; not applied',
    listBlock('movable behind find or library-brief', movable),
    listBlock('must stay', stay),
    'deleted: none',
    'changed: none',
  ].join('\n');
}

function refuse(reason: string): number {
  console.error(withhold([
    'memory-diet: refusing shrink',
    `reason: ${reason}`,
    'shrink recommendation: refused',
    'deleted: none',
    'changed: none',
  ].join('\n')));
  return 1;
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (typeof parsed === 'string') {
    console.error(`memory-diet: ${parsed}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.refuseWrite) return refuse('this checker never deletes, moves, or rewrites text');
  if (!parsed.comparison) return refuse('--comparison is required; the cold-start comparison is not done');
  const comparison = readSupplied(parsed.comparison);
  if (!comparison.ok) {
    if (comparison.why === 'missing') return refuse('comparison artifact is missing');
    if (comparison.why === 'blocked') return refuse('comparison path is not read by this checker');
    return refuse('comparison artifact cannot be read');
  }
  const verdict = comparisonVerdict(comparison.text);
  if (verdict === 'failed') return refuse('comparison artifact says the cold-start check failed');
  if (verdict !== 'passed') return refuse('comparison artifact does not say the cold-start check passed');
  if (!parsed.fixture) {
    console.error('memory-diet: --fixture is required');
    console.error(USAGE);
    return 2;
  }
  const fixture = readSupplied(parsed.fixture);
  if (!fixture.ok) {
    console.error(fixture.why === 'blocked' ? 'memory-diet: fixture path is not read by this checker' : 'memory-diet: fixture cannot be read');
    console.error('deleted: none');
    console.error('changed: none');
    return 2;
  }
  console.log(withhold(renderReport(classifyText(fixture.text))));
  return 0;
}

const isMain = (): boolean => {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};
if (isMain()) process.exit(main(process.argv.slice(2)));
