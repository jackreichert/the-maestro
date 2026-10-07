/**
 * `stream-homes.json` in the status directory: the user's own mapping of a stream to its projects, epics, docs and pins.
 * Optional. Every entry is checked by a rule table (one object per rule: what it checks, and the sentence when it fails);
 * a bad entry is dropped with a warning that becomes an unknown on the page, never a failed page.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanPath } from '../vault/reader.ts';
import { hasSecretSegment } from '../vault/secret-names.ts';

export const HOMES_FILE = 'stream-homes.json';
const MAX_BYTES = 64 * 1024;
const MAX_LIST = 50;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Pin = { label: string; url: string } | { label: string; note: string };
export interface StreamHomeConfig { projects: string[]; epics: string[]; exclude: string[]; done: Record<string, string>; docs: string[]; runbooks: string[]; pins: Pin[] }
export interface Homes { found: boolean; streams: Record<string, StreamHomeConfig>; warnings: string[] }

/** Whether `s` is a vault-relative `.md` note path: plain, no `..`, no secret-file name. */
export const isVaultNote = (s: unknown): s is string => typeof s === 'string' && s.endsWith('.md') && cleanPath(s) !== null && !hasSecretSegment(s);
/** Whether `s` is an http or https URL with no credentials in it. */
export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 2048) return false;
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === ''; } catch { return false; }
}

interface ElementRule { ok: (v: unknown) => boolean; why: string }
/** What each list field's elements must be. */
const ELEMENT_RULES: Record<'projects' | 'epics' | 'exclude' | 'docs' | 'runbooks', ElementRule> = {
  projects: { ok: (v) => typeof v === 'string' && PROJECT_NAME.test(v), why: 'is not a project folder name' },
  epics: { ok: (v) => typeof v === 'string' && PROJECT_NAME.test(v), why: 'is not a ticket id' },
  exclude: { ok: (v) => typeof v === 'string' && PROJECT_NAME.test(v), why: 'is not a ticket id' },
  docs: { ok: isVaultNote, why: 'is not a vault-relative .md path' },
  runbooks: { ok: isVaultNote, why: 'is not a vault-relative .md path' },
};
/** What each pin must satisfy, in order; the first failure is the one reported. */
const PIN_RULES: ElementRule[] = [
  { ok: (p) => typeof p === 'object' && p !== null && !Array.isArray(p), why: 'is not an object' },
  { ok: (p) => { const l = (p as { label?: unknown }).label; return typeof l === 'string' && l.trim().length > 0 && l.length <= 80; }, why: 'needs a label of 1 to 80 characters' },
  { ok: (p) => ['url', 'note'].filter((k) => k in (p as object)).length === 1, why: 'needs exactly one of url or note' },
  { ok: (p) => !('url' in (p as object)) || isHttpUrl((p as { url?: unknown }).url), why: 'has a url that is not http or https' },
  { ok: (p) => !('note' in (p as object)) || isVaultNote((p as { note?: unknown }).note), why: 'has a note that is not a vault-relative .md path' },
];

function listField(name: keyof typeof ELEMENT_RULES, raw: unknown, where: string, warn: (m: string) => void): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warn(`${where}.${name} is not a list; ignored`); return []; }
  const rule = ELEMENT_RULES[name];
  const out: string[] = [];
  raw.slice(0, MAX_LIST).forEach((v, i) => { if (rule.ok(v)) out.push(v as string); else warn(`${where}.${name}[${i}] ${rule.why}; ignored`); });
  if (raw.length > MAX_LIST) warn(`${where}.${name} has more than ${MAX_LIST} entries; the rest are ignored`);
  return out;
}

function pinsField(raw: unknown, where: string, warn: (m: string) => void): Pin[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warn(`${where}.pins is not a list; ignored`); return []; }
  const out: Pin[] = [];
  raw.slice(0, MAX_LIST).forEach((p, i) => {
    const bad = PIN_RULES.find((r) => !r.ok(p));
    if (bad) warn(`${where}.pins[${i}] ${bad.why}; ignored`);
    else { const o = p as { label: string; url?: string; note?: string }; out.push(o.url !== undefined ? { label: o.label.trim(), url: o.url } : { label: o.label.trim(), note: o.note as string }); }
  });
  return out;
}

function doneField(raw: unknown, where: string, warn: (m: string) => void): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { warn(`${where}.done is not an object; ignored`); return {}; }
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (PROJECT_NAME.test(id) && v === 'verified') out[id] = v; else warn(`${where}.done["${id.slice(0, 40)}"] must be a ticket id mapped to "verified"; ignored`);
  }
  return out;
}

/** The validated config for the streams in `known` (matched case-insensitively), and a warning for everything dropped. */
export function validateHomes(raw: unknown, known: string[]): Homes {
  const warnings: string[] = [];
  const warn = (m: string): void => { warnings.push(`${HOMES_FILE}: ${m}`); };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { warn('is not a JSON object; ignored'); return { found: true, streams: {}, warnings }; }
  const file = raw as { version?: unknown; streams?: unknown };
  if (file.version !== 1) { warn('version must be 1; ignored'); return { found: true, streams: {}, warnings }; }
  if (typeof file.streams !== 'object' || file.streams === null || Array.isArray(file.streams)) { warn('has no "streams" object; ignored'); return { found: true, streams: {}, warnings }; }
  const streams: Record<string, StreamHomeConfig> = {};
  for (const [name, entry] of Object.entries(file.streams)) {
    const canon = known.find((k) => k.toLowerCase() === name.trim().toLowerCase());
    if (!canon) { warn(`stream "${name.slice(0, 60)}" is not a known stream; ignored`); continue; }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { warn(`streams.${canon} is not an object; ignored`); continue; }
    const e = entry as Record<string, unknown>;
    const where = `streams.${canon}`;
    streams[canon] = { projects: listField('projects', e.projects, where, warn), epics: listField('epics', e.epics, where, warn), exclude: listField('exclude', e.exclude, where, warn),
      done: doneField(e.done, where, warn), docs: listField('docs', e.docs, where, warn), runbooks: listField('runbooks', e.runbooks, where, warn), pins: pinsField(e.pins, where, warn) };
  }
  return { found: true, streams, warnings };
}

/** Reads and validates `<statusDir>/stream-homes.json`. Absent is fine; a symlink, an oversize file or bad JSON is a warning. */
export function readHomes(statusDir: string, known: string[]): Homes {
  const path = join(statusDir, HOMES_FILE);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { found: true, streams: {}, warnings: [`${HOMES_FILE}: is not a regular file; ignored`] };
    if (st.size > MAX_BYTES) return { found: true, streams: {}, warnings: [`${HOMES_FILE}: is over ${MAX_BYTES / 1024} KB; ignored`] };
  } catch { return { found: false, streams: {}, warnings: [] }; }
  try { return validateHomes(JSON.parse(readFileSync(path, 'utf8')), known); } catch { return { found: true, streams: {}, warnings: [`${HOMES_FILE}: is not valid JSON; ignored`] }; }
}
