/** A library page: the frontmatter as plain values, and the body with its line numbers. Pure; reads nothing. */
export type FieldValue = string | string[];
export interface Page {
  path: string;
  fields: Map<string, FieldValue>;
  /** True when the file opens with a frontmatter block. */
  hasFrontmatter: boolean;
  /** The whole file split into lines. */
  lines: string[];
  /** Index into `lines` of the first body line (after the frontmatter). */
  bodyStart: number;
}

const unquote = (s: string): string => s.replace(/^(["'])(.*)\1$/, '$2');

/** `[a, b]` is a list, a run of `[[wikilinks]]` is a list of their targets, anything else a string; a trailing ` # comment` outside quotes is dropped. */
export function parseValue(raw: string): FieldValue {
  const v = /^["']/.test(raw.trim()) ? raw.trim() : raw.replace(/\s+#.*$/, '').trim();
  const links = [...v.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1] as string);
  if (v.startsWith('[[') && links.length) return links;
  const list = v.match(/^\[(.*)\]$/);
  if (list) return (list[1] as string).split(',').map((x) => unquote(x.trim())).filter(Boolean);
  return unquote(v);
}

export function parsePage(path: string, text: string): Page {
  const lines = text.split('\n');
  const fields = new Map<string, FieldValue>();
  if (lines[0]?.trim() !== '---') return { path, fields, hasFrontmatter: false, lines, bodyStart: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { path, fields, hasFrontmatter: false, lines, bodyStart: 0 };
  for (const l of lines.slice(1, end)) {
    const m = l.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m) fields.set(m[1] as string, parseValue(m[2] as string));
  }
  return { path, fields, hasFrontmatter: true, lines, bodyStart: end + 1 };
}

/** A field as a string ('' when absent or a list). */
export const text = (p: Page, key: string): string => { const v = p.fields.get(key); return typeof v === 'string' ? v : ''; };
/** A field as a list (a lone string is a one-item list, absent is empty). */
export const list = (p: Page, key: string): string[] => { const v = p.fields.get(key); return Array.isArray(v) ? v : v ? [v] : []; };

/** A wikilink as written (`[[note#heading|alias]]`, `[[folder/note.md]]`) reduced to what it points at: no alias, no heading or block anchor, no `.md`. Empty for a link to a heading in the same page. */
export const linkTarget = (raw: string): string => raw.replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').replace(/#.*$/, '').trim().replace(/\.md$/, '');

/** The wikilinks in the body (embeds included) with their 1-based file lines, anchors and aliases removed. Fenced and inline code are not links. */
export function bodyLinks(p: Page): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  let fence = '';
  p.lines.forEach((t, i) => {
    if (i < p.bodyStart) return;
    const f = t.match(/^\s*(```|~~~)/);
    if (f) { fence = fence ? (fence === f[1] ? '' : fence) : (f[1] as string); return; }
    if (fence) return;
    for (const m of t.replace(/`[^`]*`/g, '').matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
      const target = linkTarget(m[1] as string);
      if (target) out.push({ line: i + 1, target });
    }
  });
  return out;
}
