#!/usr/bin/env node
/**
 * FRESH-INSTALL SMOKE: run the README Quick start verbatim in a throwaway HOME and vault, then the
 * checkout's own install, typecheck and tests.
 *
 *   node scripts/fresh-install-smoke.ts [--remote] [--keep]
 *
 * It reads every fenced bash block under "## Quick start" in README.md and runs them in order with bash under a
 * temp HOME, with VAULT_ROOT pointing at a temp vault. Only two lines are rewritten: the clone source
 * (this checkout's HEAD, so the committed tree is what gets tested; `--remote` keeps the real URL) and the
 * vault path placeholder. Then, inside the clone, it runs `npm ci`, `npm run typecheck` and `npm test`.
 * SMOKE_TEST_TIMEOUT_S (default 600) caps the test step. SIGTERM, SIGINT and SIGHUP stop the running step and remove the temp dir. Exit 0 when every step passed, 1 on the first failure (the step is named), 2 on bad usage.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every ```bash block between the Quick start heading and the next heading, joined in order. */
export function quickStartBlock(readme: string): string {
  const start = readme.indexOf('\n## Quick start');
  if (start < 0) throw new Error('README has no "## Quick start" section');
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ', 4);
  const blocks = [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (!blocks.length) throw new Error('Quick start has no bash block');
  return blocks.join('\n');
}

/** Point the clone at `source` and the vault placeholder at `vault`; fail if either line is missing. */
export function rewrite(block: string, source: string | null, vault: string): string {
  let out = block;
  if (source !== null) {
    const next = out.replace(/(git clone )\S+/, `$1${source}`);
    if (next === out) throw new Error('Quick start has no git clone line');
    out = next;
  }
  const next = out.replace('"/absolute/path/to/your/vault"', `"${vault}"`);
  if (next === out) throw new Error('Quick start has no VAULT_ROOT placeholder');
  return next;
}

/** The step currently running, so a signal can take it down with us. */
let running: ChildProcess | null = null;

/** Run one step in its own process group (so its children die with it); resolves on pass, rejects on failure. */
function step(name: string, cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const t0 = Date.now();
  return new Promise((done, fail) => {
    const child = spawn(cmd, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let out = '';
    const keep = (d: Buffer) => { out = (out + d).slice(-64 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => { running = null; fail(e); });
    child.on('close', (code) => {
      running = null;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) { console.log(`PASS ${name} (${secs}s)`); done(); return; }
      console.error(`FAIL ${name} (exit ${code}, ${secs}s)\n${out.trimEnd().split('\n').slice(-25).join('\n')}`);
      process.exitCode = 1;
      fail(new Error(name));
    });
  });
}

/** Kill the running step's whole process group. */
function killRunning(): void {
  if (running?.pid) { try { process.kill(-running.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

async function main(): Promise<void> {
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--remote' && a !== '--keep');
if (unknown.length) { console.error(`usage: fresh-install-smoke.ts [--remote] [--keep] (unknown: ${unknown.join(' ')})`); process.exit(2); }
const remote = args.includes('--remote');
const keep = args.includes('--keep');
  const root = mkdtempSync(join(tmpdir(), 'maestro-smoke-'));
  const home = join(root, 'home');
  const vault = join(root, 'vault');
  spawnSync('mkdir', ['-p', home, vault]);
  // Keep the caller's PATH (node, npm, git) but nothing that could leak an existing install or vault.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8' };
  // The outer `timeout` (or Ctrl-C) sends a signal: stop the running step and remove the temp dir before exiting.
  const onSignal = (sig: NodeJS.Signals) => {
    killRunning();
    if (!keep) rmSync(root, { recursive: true, force: true });
    process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGHUP' ? 1 : 15));
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, onSignal);
  try {
    const block = rewrite(quickStartBlock(readFileSync(join(repo, 'README.md'), 'utf8')), remote ? null : repo, vault);
    await step('quick start', 'bash', ['-euo', 'pipefail', '-c', block], home, env);
    const clone = join(home, '.claude', 'skills', 'the-maestro');
    if (!existsSync(join(clone, 'SKILL.md'))) throw new Error('clone has no SKILL.md');
    if (!existsSync(join(vault, 'Projects', 'my-workspace', 'Journal'))) { console.error('FAIL quick start did not create the Journal folder after logging an entry'); process.exitCode = 1; throw new Error('journal'); }
    console.log('PASS journal folder created');
    await step('npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], clone, env);
    await step('typecheck', 'npm', ['run', 'typecheck'], clone, env);
    await step('test', 'timeout', [process.env.SMOKE_TEST_TIMEOUT_S ?? '600', 'npm', 'test'], clone, env);
    console.log('fresh-install smoke: all steps passed');
  } catch (e) {
    if (!process.exitCode) { console.error(`FAIL ${(e as Error).message}`); process.exitCode = 1; }
  } finally {
    if (keep) console.log(`kept ${root}`); else rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
