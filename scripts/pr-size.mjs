#!/usr/bin/env node
/**
 * PR SIZE: the budget gate run before a draft PR is opened (reference/git.md, "PR size budget").
 *
 *   node scripts/pr-size.mjs --repo <path> --base <ref> [--head <ref>] [--json]
 *
 * Reads `git diff --numstat -M -z <base>...<head>` (head defaults to HEAD), sorts each changed file
 * into code, test, config, docs or mechanical, and checks the code against two limits, whichever is
 * hit first: pr_max_code_files (default 5) and pr_max_code_lines (default 400, additions plus
 * deletions). Limits and path globs come from local-config.mjs.
 *
 * Mechanical changes (lockfiles, generated or vendored files, pure renames) are exempt only when the
 * PR holds no code: code plus mechanical files fails as "mixed". Migrations count as code.
 * Exit 0 within budget, 1 over budget or mixed, 2 on bad usage or a git error.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PR_MAX_CODE_FILES, PR_MAX_CODE_LINES, PR_TEST_GLOBS, PR_CONFIG_GLOBS, PR_DOCS_GLOBS, PR_MECHANICAL_GLOBS,
} from './local-config.mjs';

/**
 * Default path globs. Directory globs never decide a code file's bucket: CODE_EXT files can only be
 * test, migration, mechanical or code (see makeClassifier). Mechanical directories are anchored at the
 * repo root or a package root, so `src/vendor/x.ts` stays code.
 */
export const DEFAULT_GLOBS = {
  mechanical: [
    'uv.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'Pipfile.lock',
    'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', '*.lock', '*.tgz', '*.tar.gz', '*.min.js', '*.min.css',
    '*.map', '*.generated.*', '*_pb2.py', '*_pb2_grpc.py', '*.pb.go', '**/node_modules/**',
    'vendor/**', 'generated/**', '__generated__/**', 'dist/**', 'third_party/**',
    'packages/*/vendor/**', 'packages/*/generated/**', 'packages/*/__generated__/**', 'packages/*/dist/**',
    'apps/*/vendor/**', 'apps/*/generated/**', 'apps/*/__generated__/**', 'apps/*/dist/**',
  ],
  test: [
    '**/test/**', '**/tests/**', '**/__tests__/**', '**/__mocks__/**', '**/e2e/**',
    '*.test.*', '*.spec.*', '*_test.*', 'conftest.py',
  ],
  config: [
    '*.json', '*.yaml', '*.yml', '*.toml', '*.ini', '*.cfg', '*.conf', '.editorconfig', '.gitignore', '.gitattributes',
    'Dockerfile', 'Dockerfile.*', '*.dockerfile', '.dockerignore', '.github/**', '.gitlab-ci.yml', '.circleci/**',
    '.env.example',
  ],
  docs: [
    '*.md', '*.mdx', '*.rst', '*.txt', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.webp', '*.ico', 'LICENSE*',
  ],
};

/** Source-code extensions. Such a file is never docs or config, whatever directory it sits in. */
export const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|kts|rs|sql|sh|bash|zsh|c|cc|cpp|h|hpp|cs|php|swift|scala|ex|exs|lua|pl|dart|vue|svelte)$/i;

/** Turns a path glob into a RegExp: `**` crosses directories, `*` and `?` stay inside one. A glob with no slash matches any basename. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${glob.includes('/') ? '' : '(?:.*/)?'}${re}$`);
}

const matcher = (globs) => { const res = globs.map(globToRegExp); return (p) => res.some((r) => r.test(p)); };

/** Migrations are code however they are named: anything under a migrations directory, and .sql files there. */
export const isMigration = (p) => /(^|\/)migrations?\//.test(p);

/** Builds classify(file) from the configured globs, falling back to DEFAULT_GLOBS per category. */
export function makeClassifier(overrides = {}) {
  const pick = (k, configured) => matcher(configured?.length ? configured : DEFAULT_GLOBS[k]);
  const isMechanical = pick('mechanical', overrides.mechanical);
  const isTest = pick('test', overrides.test);
  const isConfig = pick('config', overrides.config);
  const isDocs = pick('docs', overrides.docs);
  return ({ path, renamed, added, deleted }) => {
    if (renamed && added === 0 && deleted === 0) return 'mechanical';
    if (isMechanical(path)) return 'mechanical';
    if (isMigration(path)) return 'code';
    if (isTest(path)) return 'test';
    if (CODE_EXT.test(path)) return 'code';
    if (isConfig(path)) return 'config';
    if (isDocs(path)) return 'docs';
    return 'code';
  };
}

/** Parses `git diff --numstat -M -z` output into [{ path, from, renamed, added, deleted }]. Binary files count 0 lines. */
export function parseNumstat(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    const [, a, d, rest] = m;
    const nums = { added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) };
    if (rest === '') { files.push({ ...nums, from: parts[i + 1], path: parts[i + 2], renamed: true }); i += 2; }
    else files.push({ ...nums, path: rest, renamed: false });
  }
  return files;
}

/** Classifies files and applies the budget. Pure: returns the summary object the CLI prints. */
export function assess(files, { maxFiles, maxLines, classify }) {
  const buckets = { code: [], test: [], config: [], docs: [], mechanical: [] };
  for (const f of files) buckets[classify(f)].push(f);
  const sum = (list) => list.reduce((n, f) => n + f.added + f.deleted, 0);
  const codeFiles = buckets.code.length;
  const codeLines = sum(buckets.code);
  const failures = [];
  if (codeFiles > maxFiles) failures.push(`over budget: ${codeFiles} code files (max ${maxFiles})`);
  if (codeLines > maxLines) failures.push(`over budget: ${codeLines} code lines (max ${maxLines})`);
  if (codeFiles > 0 && buckets.mechanical.length > 0) failures.push('mechanical changes go in their own PR');
  return {
    verdict: failures.length ? 'FAIL' : 'PASS',
    failures,
    limits: { maxFiles, maxLines },
    code: { files: codeFiles, lines: codeLines, paths: buckets.code.map((f) => f.path) },
    tests: { files: buckets.test.length, lines: sum(buckets.test) },
    config: { files: buckets.config.length, lines: sum(buckets.config) },
    docs: { files: buckets.docs.length, lines: sum(buckets.docs) },
    mechanical: { files: buckets.mechanical.length, paths: buckets.mechanical.map((f) => f.path) },
  };
}

function usage(msg) {
  if (msg) console.error(`pr-size: ${msg}`);
  console.error('usage: node scripts/pr-size.mjs --repo <path> --base <ref> [--head <ref>] [--json]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { repo: '', base: '', head: 'HEAD', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--repo' || a === '--base' || a === '--head') o[a.slice(2)] = argv[++i] ?? '';
    else usage(`unknown argument ${a}`);
  }
  if (!o.repo || !o.base) usage('--repo and --base are required');
  return o;
}

function render(r) {
  const lines = [
    `code:       ${r.code.files} files, ${r.code.lines} lines (limit ${r.limits.maxFiles} files, ${r.limits.maxLines} lines)`,
    `tests:      ${r.tests.files} files, ${r.tests.lines} lines (not counted)`,
    `config:     ${r.config.files} files, ${r.config.lines} lines (not counted)`,
    `docs:       ${r.docs.files} files, ${r.docs.lines} lines (not counted)`,
    `mechanical: ${r.mechanical.files} files${r.mechanical.files ? ` (${r.mechanical.paths.join(', ')})` : ''}`,
    `verdict:    ${r.verdict}`,
  ];
  for (const f of r.failures) lines.push(`  - ${f}`);
  if (r.verdict === 'FAIL') lines.push('Split into a stack of PRs, each passing tests on its own; mechanical changes go alone.');
  return lines.join('\n');
}

function main() {
  const { repo, base, head, json } = parseArgs(process.argv.slice(2));
  const g = spawnSync('git', ['-C', repo, 'diff', '--numstat', '-M', '-z', `${base}...${head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (g.status !== 0) { console.error(`pr-size: git diff failed: ${(g.stderr || '').trim()}`); process.exit(2); }
  const classify = makeClassifier({ mechanical: PR_MECHANICAL_GLOBS, test: PR_TEST_GLOBS, config: PR_CONFIG_GLOBS, docs: PR_DOCS_GLOBS });
  const result = assess(parseNumstat(g.stdout), { maxFiles: PR_MAX_CODE_FILES, maxLines: PR_MAX_CODE_LINES, classify });
  console.log(json ? JSON.stringify(result, null, 2) : render(result));
  process.exit(result.verdict === 'PASS' ? 0 : 1);
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
