/**
 * A tiny Markdown renderer for the Podium client: just what the status page emits.
 *
 * Blocks: headings, paragraphs, bullet/numbered lists (with `[ ]`/`[x]` boxes), block quotes, tables, fenced code.
 * Inline: `code`, **bold**, [links](url) and the generator's nowrap span.
 * Inline text is matched first and escaped per segment: the text between matches and the contents of each match are
 * HTML-escaped before they reach the output, so the only tags emitted are the ones this file writes. A backslash before
 * ASCII punctuation makes that character literal (the generator escapes its own text that way), and it never starts a match.
 * Link targets are limited by url.ts: http, https, and `obsidian://open` with only `vault` and `file`.
 * Pure and DOM-free so node:test covers it.
 */
import { isSafeUrl } from './url.ts';
import { linkAttrs } from './link-policy.ts';

export { isSafeUrl };

const NOWRAP_OPEN = '<span style="white-space:nowrap">';
const NOWRAP_CLOSE = '</span>';
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const INLINE = new RegExp(
  [
    '\\\\([!-/:-@[-`{-~])', // 1: an escaped punctuation character
    `${literal(NOWRAP_OPEN)}(.*?)${literal(NOWRAP_CLOSE)}`, // 2: nowrap inner
    '`([^`]+)`', // 3: code
    '\\*\\*((?:\\\\.|[^\\\\])+?)\\*\\*', // 4: bold
    '\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(([^)\\s]*)\\)', // 5: label, 6: url
  ].join('|'),
  'g',
);

/** Escape the characters that matter in HTML text and quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** An anchor with the link policy's attributes, or just the label when the URL is unsafe. */
function renderLink(label: string, url: string): string {
  const attrs = linkAttrs(url);
  if (attrs === undefined) return renderInline(label);
  const html = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  return `<a${html}>${renderInline(label)}</a>`;
}

/** Render one line of inline Markdown to HTML. */
export function renderInline(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out += escapeHtml(m[1]);
    else if (m[2] !== undefined) out += `<span class="nw">${renderInline(m[2])}</span>`;
    else if (m[3] !== undefined) out += `<code>${escapeHtml(m[3])}</code>`;
    else if (m[4] !== undefined) out += `<strong>${renderInline(m[4])}</strong>`;
    else out += renderLink(m[5], m[6]);
  }
  return out + escapeHtml(text.slice(last));
}

/** Split a table row into trimmed cells; a pipe inside a code span or after a backslash does not split. A backslash pair stays a pair. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '\\' && i + 1 < body.length) { cur += c + body[i + 1]; i++; }
    else if (c === '`') { inCode = !inCode; cur += c; }
    else if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') cells.push(cur.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)(?:([-*])|(\d+)[.)])\s+(.*)$/;
const BOX = /^\[([ xX])\]\s+/;

function renderTable(lines: string[]): string {
  const head = splitRow(lines[0]).map((c) => `<th scope="col">${renderInline(c)}</th>`).join('');
  const body = lines.slice(2).map((l) => `<tr>${splitRow(l).map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderItem(text: string, extra: string[]): string {
  const box = BOX.exec(text);
  const open = box?.[1] === ' ';
  const mark = box ? `<span class="box" role="img" aria-label="${open ? 'open' : 'done'}">${open ? '☐' : '☑'}</span> ` : '';
  const inner = renderInline(box ? text.slice(box[0].length) : text);
  const lines = extra.map((l) => l.trim()).filter((l) => l !== '');
  const tail = lines.map((l) => (l.startsWith('>') ? `<blockquote>${renderInline(l.replace(/^>\s?/, ''))}</blockquote>` : ` ${renderInline(l)}`));
  return `<li>${mark}${inner}${tail.join('')}</li>`;
}

function renderList(lines: string[]): string {
  const tag = LIST_ITEM.exec(lines[0])?.[3] ? 'ol' : 'ul';
  const items: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i++]);
    const extra: string[] = [];
    while (i < lines.length && !LIST_ITEM.test(lines[i])) extra.push(lines[i++]);
    items.push(renderItem(m ? m[4] : '', extra));
  }
  return `<${tag}>${items.join('')}</${tag}>`;
}

const BLOCK_START = /^(#{1,6}\s|\s*```|\s*>|\s*\|)/;

/** Render a Markdown document or fragment to an HTML string. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); i++; continue; }
    const start = i;
    if (line.trimStart().startsWith('|') && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++);
      out.push(renderTable(lines.slice(start, i)));
    } else if (LIST_ITEM.test(line)) {
      for (i++; i < lines.length && lines[i].trim() !== '' && (LIST_ITEM.test(lines[i]) || /^\s+\S/.test(lines[i])); i++);
      out.push(renderList(lines.slice(start, i)));
    } else if (/^\s*>/.test(line)) {
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++);
      out.push(`<blockquote>${lines.slice(start, i).map((l) => renderInline(l.replace(/^\s*>\s?/, ''))).join('<br>')}</blockquote>`);
    } else {
      for (i++; i < lines.length && lines[i].trim() !== '' && !BLOCK_START.test(lines[i]) && !LIST_ITEM.test(lines[i]); i++);
      out.push(`<p>${lines.slice(start, i).map(renderInline).join(' ')}</p>`);
    }
  }
  return out.join('\n');
}
