#!/usr/bin/env node
/**
 * CI GATES: the size, body, and smells checks, run where a writing agent cannot loosen them.
 *
 *   node scripts/ci-gates.ts --repo <path> --base <ref> --body-file <path> (--title <text> | --title-file <path>) [--head <ref>] [--base-name <branch>]
 *
 * pr-size, pr-body, and pr-smells read their limits when they load local-config, and local-config
 * reads process.env at import. This script deletes the gate overrides first, then imports those
 * modules, so a caller cannot raise a limit, reclassify code out of the budget, turn a body check
 * off, or point MAESTRO_LOCAL_CONFIG at a looser file. There is no flag that skips a gate.
 *
 * The user config file at its default path is still read. That is the only remaining waiver:
 * waive_size_gate_owners, the list pr-open.ts already honours. An environment variable cannot
 * set it. Mixing code with mechanical files is never waived.
 *
 * --base is the diff base (a branch or a sha). --base-name is the branch name used to decide
 * whether the PR is stacked; it defaults to --base. Pass both when --base is a sha, or a sha
 * would look stacked and demand a Stack section.
 * Exit 0 when every gate passes, 1 when one refuses, 2 on bad usage or a git error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Names that can change a size, body, or smells answer. MAESTRO_LOCAL_CONFIG names the file that
 * holds the file-only limits, so it is one of them. MAESTRO_PR_* covers the thresholds and globs
 * local-config still reads from the environment. The waiver list is not settable from here.
 */
export function isGateOverride(key: string): boolean {
  return key === 'MAESTRO_LOCAL_CONFIG'
    || key === 'MAESTRO_OVERLAY'
    || key === 'MAESTRO_PROTECTED_BRANCHES'
    || key === 'MAESTRO_WAIVE_SIZE_GATE_OWNERS'
    || key.startsWith('MAESTRO_PR_');
}

/** Deletes gate overrides from `env` in place. Returns the names removed, sorted. Values are not returned. */
export function stripGateEnv(env: NodeJS.ProcessEnv): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(env)) {
    if (!isGateOverride(key)) continue;
    delete env[key];
    stripped.push(key);
  }
  return stripped.sort();
}

interface GateArgs {
  repo: string;
  base: string;
  baseName: string;
  head: string;
  title: string;
  bodyFile: string;
}

function usage(msg?: string): never {
  if (msg) console.error(`ci-gates: ${msg}`);
  console.error('usage: node scripts/ci-gates.ts --repo <path> --base <ref> --body-file <path> (--title <text> | --title-file <path>) [--head <ref>] [--base-name <branch>]');
  process.exit(2);
}

function parseArgs(argv: string[]): GateArgs {
  const o = { repo: '', base: '', baseName: '', head: 'HEAD', title: '', titleFile: '', bodyFile: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' || a === '--base' || a === '--base-name' || a === '--head' || a === '--title' || a === '--title-file' || a === '--body-file') {
      const key = a === '--repo' ? 'repo'
        : a === '--base' ? 'base'
          : a === '--base-name' ? 'baseName'
            : a === '--head' ? 'head'
              : a === '--title' ? 'title'
                : a === '--title-file' ? 'titleFile'
                  : 'bodyFile';
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) usage(`${a} needs a value`);
      o[key] = value;
    } else usage(`unknown argument ${a} (no flag skips a gate)`);
  }
  if (!o.repo || !o.base) usage('--repo and --base are required');
  if (!o.bodyFile) usage('--body-file is required');
  if (!o.title && !o.titleFile) usage('--title or --title-file is required');
  if (o.title && o.titleFile) usage('pass --title or --title-file, not both');
  let title = o.title;
  if (o.titleFile) {
    try { title = readFileSync(resolve(o.titleFile), 'utf8'); } catch (e) { console.error(`ci-gates: cannot read --title-file: ${(e as Error).message}`); process.exit(2); }
    title = title.replace(/\n$/, '');
  }
  return { repo: o.repo, base: o.base, baseName: o.baseName || o.base, head: o.head, title, bodyFile: o.bodyFile };
}

function readBody(path: string): string {
  try { return readFileSync(resolve(path), 'utf8'); } catch (e) { console.error(`ci-gates: cannot read --body-file: ${(e as Error).message}`); process.exit(2); }
}

async function run(argv: string[], stripped: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (stripped.length) console.error(`ci-gates: ignored environment overrides: ${stripped.join(', ')}`);
  process.env.GIT_TERMINAL_PROMPT ??= '0';
  // Import only after the overrides are gone. A static import would load local-config first.
  const [{ assess, makeClassifier, parseNumstat, resolveBase, globToRegExp }, { bodyProblems }, { smellsProblems }, { sizeGateWaiver }, config] = await Promise.all([
    import('./pr-size.ts'),
    import('./pr-body.ts'),
    import('./pr-smells.ts'),
    import('./pr-open.ts'),
    import('./local-config.ts'),
  ]);
  const resolved = resolveBase(args.repo, args.base);
  const diff = spawnSync('git', ['-C', args.repo, 'diff', '--numstat', '-M', '-z', `${resolved}...${args.head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) { console.error(`ci-gates: git diff failed: ${(diff.stderr || '').trim()}`); return 2; }
  const classify = makeClassifier({ mechanical: config.PR_MECHANICAL_GLOBS, test: config.PR_TEST_GLOBS, config: config.PR_CONFIG_GLOBS, docs: config.PR_DOCS_GLOBS });
  const size = assess(parseNumstat(diff.stdout || ''), {
    maxFiles: config.PR_MAX_CODE_FILES, maxLines: config.PR_MAX_CODE_LINES, wideMaxFiles: config.PR_WIDE_MAX_CODE_FILES, wideMaxLines: config.PR_WIDE_MAX_CODE_LINES, classify,
  });
  const mixed = size.code.files > 0 && size.mechanical.files > 0;
  const waived = size.verdict === 'FAIL' && !mixed ? sizeGateWaiver(args.repo) : '';
  const sizeProblems = waived ? [] : size.failures;
  const body = readBody(args.bodyFile);
  const stacked = !config.PROTECTED_BRANCHES.some((g) => globToRegExp(g).test(args.baseName));
  const bodyProblemsFound = bodyProblems(body, undefined, { stacked, codeFiles: size.code.files, title: args.title });
  let smellProblems: string[];
  try { smellProblems = smellsProblems(args.repo, args.head, body, size.code.files); } catch (e) { smellProblems = [(e as Error).message]; }
  const limit = size.limits.wideMaxFiles === undefined
    ? `${size.limits.maxFiles} files, ${size.limits.maxLines} lines`
    : `${size.limits.maxFiles} files, ${size.limits.maxLines} lines, or up to ${size.limits.wideMaxFiles} files under ${size.limits.wideMaxLines} lines`;
  console.log(`size: ${size.code.files} code files, ${size.code.lines} code lines (limit ${limit}) — ${sizeProblems.length ? 'FAIL' : 'PASS'}`);
  if (waived) console.log(`ci-gates: size limits waived for ${waived} (waive_size_gate_owners); the counts above are informational. The rule that mechanical changes go in their own PR still applies.`);
  for (const f of sizeProblems) console.error(`size: ${f}`);
  console.log(`body: ${bodyProblemsFound.length ? 'FAIL' : 'PASS'}`);
  for (const f of bodyProblemsFound) console.error(`body: ${f}`);
  console.log(`smells: ${smellProblems.length ? 'FAIL' : 'PASS'}`);
  for (const f of smellProblems) console.error(`smells: ${f}`);
  return sizeProblems.length || bodyProblemsFound.length || smellProblems.length ? 1 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  const stripped = stripGateEnv(process.env);
  run(process.argv.slice(2), stripped).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(`ci-gates: ${(e as Error).message}`); process.exitCode = 2; },
  );
}
