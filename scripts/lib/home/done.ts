/**
 * The stream's definition of done, read from where it is written: the open epics' `## What done looks like` and each mapped
 * project's `CONTEXT.md` section of the same name. Pure: the caller hands over the text it already read. Nothing is copied or
 * invented; a stream with no such section gets the file to add one to, not a made-up goal.
 */
import { obsidianUri } from '../status-page/links.ts';
import type { Ref } from './types.ts';

export interface DoneItem { text: string; checked: boolean | null }
export interface DoneSource {
  kind: 'epic' | 'project';
  name: string;
  ref: Ref;
  items: DoneItem[];
  /** Lines that are not list items, joined; null when there are none. */
  prose: string | null;
  /** Items beyond the cap, not listed. */
  more: number;
  /** Checked of the checkbox items, or for an epic with none, its closed tickets of all; null when nothing is countable. */
  progress: { done: number; total: number; unit: 'checked' | 'tickets' } | null;
  finished: boolean;
}
export interface StreamDone { sources: DoneSource[]; fix: string | null }

export interface DoneEpic { id: string; status: string; closed: number; total: number; body: string; ref: Ref }
export interface DoneInput {
  stream: string;
  epics: DoneEpic[];
  projects: { project: string; text: string | null }[];
  vaultName: string | undefined;
}

const HEADING = /^## What done looks like\s*$/i;
const ITEM_MAX = 12;
const TEXT_MAX = 200;
const PROSE_MAX = 400;
const SOURCE_MAX = 8;

const clip = (s: string, n: number): string => { const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The lines under the done heading, up to the next `## `. Null when the heading is absent or empty. */
function doneLines(body: string): string[] | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => HEADING.test(l));
  if (at === -1) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const own = (end === -1 ? rest : rest.slice(0, end)).filter((l) => l.trim());
  return own.length ? own : null;
}

/** List items (checkbox, bullet or numbered) and the prose around them. */
function parse(lines: string[]): { items: DoneItem[]; prose: string | null } {
  const items: DoneItem[] = [];
  const prose: string[] = [];
  for (const l of lines) {
    const m = /^\s*(?:[-*]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(l);
    if (!m) { prose.push(l.trim()); continue; }
    const text = clip(m[2] ?? '', TEXT_MAX);
    if (text) items.push({ text, checked: m[1] === undefined ? null : m[1] !== ' ' });
  }
  return { items, prose: prose.length ? clip(prose.join(' '), PROSE_MAX) : null };
}

function source(kind: DoneSource['kind'], name: string, ref: Ref, lines: string[], epic?: DoneEpic): DoneSource {
  const { items, prose } = parse(lines);
  const boxes = items.filter((i) => i.checked !== null);
  const ticketsCounted = !boxes.length && epic !== undefined && epic.total > 0;
  const progress: DoneSource['progress'] = boxes.length ? { done: boxes.filter((i) => i.checked).length, total: boxes.length, unit: 'checked' }
    : ticketsCounted ? { done: epic.closed, total: epic.total, unit: 'tickets' } : null;
  return { kind, name, ref, items: items.slice(0, ITEM_MAX), prose, more: Math.max(0, items.length - ITEM_MAX), progress, finished: progress !== null && progress.total > 0 && progress.done === progress.total };
}

export function buildDone(inp: DoneInput): StreamDone {
  const sources: DoneSource[] = [];
  for (const e of inp.epics) {
    if (e.status === 'closed') continue;
    const lines = doneLines(e.body);
    if (lines) sources.push(source('epic', e.id, e.ref, lines, e));
  }
  for (const p of inp.projects) {
    const lines = p.text ? doneLines(p.text) : null;
    const path = `Projects/${p.project}/CONTEXT.md`;
    const ref: Ref = { label: 'CONTEXT', ...(inp.vaultName ? { url: obsidianUri(inp.vaultName, path.replace(/\.md$/, '')) } : {}) };
    if (lines) sources.push(source('project', p.project, ref, lines));
  }
  if (sources.length) return { sources: sources.slice(0, SOURCE_MAX), fix: null };
  const where = [...inp.projects.map((p) => `Projects/${p.project}/CONTEXT.md`), ...inp.epics.filter((e) => e.status !== 'closed').map((e) => `the ${e.id} epic ticket`)];
  const target = where.length ? where.slice(0, 3).join(' or ') : 'a project note or an epic ticket for this stream';
  return { sources: [], fix: `Nothing written says what done looks like for ${inp.stream}. Add a "## What done looks like" section to ${target}.` };
}
