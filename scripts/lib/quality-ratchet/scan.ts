/** Find in-scope TypeScript files under scripts/ and measure them; read and write the baseline. */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { measureSource, LIMITS, type FileMetrics } from './measure.ts';
import type { Baseline } from './ratchet.ts';

const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'fixture', '__fixtures__', 'test', 'tests', 'dist']);

/** In scope: production TypeScript, not tests, test cases, fixtures or declarations. */
export function inScope(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
  const base = parts[parts.length - 1];
  return base.endsWith('.ts') && !base.endsWith('.d.ts') && !/\.(?:test|cases)\.ts$/.test(base)
    && !/-fixture\.ts$/.test(base) && base !== 'fixture.ts';
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full, root, out); continue; }
    const rel = relative(root, full).split('\\').join('/');
    if (inScope(rel)) out.push(rel);
  }
}

/** Measure every in-scope file under `<root>/scripts`. */
export function scanRepo(root: string): Record<string, FileMetrics> {
  const files: string[] = [];
  if (existsSync(join(root, 'scripts'))) walk(join(root, 'scripts'), root, files);
  const out: Record<string, FileMetrics> = {};
  for (const rel of files.sort()) out[rel] = measureSource(readFileSync(join(root, rel), 'utf8'), rel);
  return out;
}

export const BASELINE_FILE = 'quality-baseline.json';

export function baselineExists(root: string): boolean {
  return existsSync(join(root, BASELINE_FILE));
}

export function readBaseline(root: string): Baseline {
  const path = join(root, BASELINE_FILE);
  if (!existsSync(path)) return { version: 1, limits: LIMITS, files: {}, loosened: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

/** One file entry per line, so concurrent PRs touching different files merge cleanly. */
export function writeBaseline(root: string, b: Baseline): void {
  const entries = Object.entries(b.files).map(([f, m]) => `    ${JSON.stringify(f)}: ${JSON.stringify(m)}`);
  const loosened = b.loosened.map((l) => `    ${JSON.stringify(l)}`);
  const text = `{\n  "version": 1,\n  "limits": ${JSON.stringify(b.limits)},\n  "files": {\n${entries.join(',\n')}\n  },\n`
    + `  "loosened": [\n${loosened.join(',\n')}\n  ]\n}\n`;
  writeFileSync(join(root, BASELINE_FILE), text);
}
