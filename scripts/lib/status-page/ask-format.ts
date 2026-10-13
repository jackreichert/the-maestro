/**
 * How an ask's context is laid out for reading. A dense one-line context ("Options: (a) ... (b) ... Recommend (a). Stakes: ...") is
 * cut into short paragraphs, a `Label:` sentence gets its label set apart, and inline `(1) ... (2) ...` or `(a) ... (b) ...` become a list.
 * A context the writer already broke into lines, or one that is short, is left exactly as written. Nothing is dropped or reworded:
 * only whitespace between sentences and the markers' own punctuation change. Pure; the Markdown page and the web card both read the
 * same blocks, and no ledger row is rewritten.
 */

/** One run of reading: a paragraph (with its `Label:` when it opens with one) or a list whose markers were `(1)` or `(a)`. */
export type AskBlock =
  | { kind: 'p'; text: string; label?: string }
  | { kind: 'list'; marks: string[]; items: string[] };

/** A context at or under this many characters, with no list markers in it, is already one readable paragraph. */
const SHORT = 160;
/** A paragraph takes up to this many sentences and characters before the next one starts a new paragraph. */
const PARA_SENTENCES = 2;
const PARA_CHARS = 240;

const ABBREVIATION = /(?:\be\.g|\bi\.e|\bvs|\betc|\bapprox|\bcf|\bno|\bv\d+)\.$/i;
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9(\[*`])/;
const LABEL = /^([A-Z][A-Za-z0-9 /-]{0,28}):\s+(\S.*)$/s;
const MARKER = /\(([0-9]{1,2}|[a-z])\)\s*/g;

/** `text` cut into sentences; a full stop after an abbreviation does not end one. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(SENTENCE_END)) {
    const last = out.length - 1;
    if (last >= 0 && ABBREVIATION.test(out[last] as string)) out[last] += ` ${part}`;
    else out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The best `(1) (2) ...` or `(a) (b) ...` run in `text` as marker positions: the longest, then the tightest; empty when no run has two. */
function markerRun(text: string): { mark: string; start: number; end: number }[] {
  const found = [...text.matchAll(MARKER)].map((m) => ({ mark: m[1] as string, start: m.index as number, end: (m.index as number) + m[0].length }));
  let best: typeof found = [];
  const span = (r: typeof found): number => (r[r.length - 1] as { start: number }).start - (r[0] as { start: number }).start;
  for (const first of found) {
    const numeric = /^\d/.test(first.mark);
    if (first.mark !== (numeric ? '1' : 'a')) continue;
    const run = [first];
    for (const next of found) {
      if (next.start <= (run[run.length - 1] as { start: number }).start) continue;
      const want = numeric ? String(run.length + 1) : String.fromCharCode(97 + run.length);
      if (next.mark === want) run.push(next);
    }
    if (run.length >= 2 && (run.length > best.length || (run.length === best.length && span(run) < span(best)))) best = run;
  }
  return best;
}

/** An item without the marker punctuation after it (`;`, `,`, a dash); a joining word (`and`, `or`) stays, since it says whether the items are all wanted or one is chosen: whitespace is squashed first so the trailing match cannot backtrack over a long run. */
const tidyItem = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/(?: ?[;,—])+$/, '').trim();

/** Sentences into paragraphs: a `Label:` sentence opens its own; others join up to the paragraph budget. */
function paragraphs(text: string): AskBlock[] {
  const out: { label?: string; parts: string[] }[] = [];
  for (const s of sentences(text)) {
    const labelled = LABEL.exec(s);
    const cur = out[out.length - 1];
    const fits = cur && !labelled && cur.parts.length < PARA_SENTENCES && cur.parts.join(' ').length + s.length <= PARA_CHARS;
    if (fits) cur.parts.push(s);
    else out.push(labelled ? { label: labelled[1] as string, parts: [labelled[2] as string] } : { parts: [s] });
  }
  return out.map((p) => ({ kind: 'p', text: p.parts.join(' '), ...(p.label ? { label: p.label } : {}) }));
}

/** An ask's context as blocks. Written line breaks, or a short context with no list in it, come back as one paragraph block of the text as given. */
export function askBlocks(context: string): AskBlock[] {
  const text = context.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const run = text.includes('\n') ? [] : markerRun(text);
  if (text.includes('\n') || (run.length === 0 && text.length <= SHORT)) return [{ kind: 'p', text }];
  if (run.length === 0) return paragraphs(text);
  const lead = text.slice(0, run[0]?.start).trim();
  const bodies = run.map((m, i) => text.slice(m.end, run[i + 1]?.start ?? text.length));
  const [firstSentence = '', ...rest] = sentences(bodies[bodies.length - 1] as string);
  bodies[bodies.length - 1] = firstSentence;
  return [
    ...(lead ? paragraphs(lead) : []),
    { kind: 'list', marks: run.map((m) => m.mark), items: bodies.map(tidyItem) },
    ...(rest.length ? paragraphs(rest.join(' ')) : []),
  ];
}

/** The blocks as Markdown for the web card: blank lines between blocks, `1.` for numbered markers, `- **(a)**` for lettered ones, `**Label:**` ahead of a labelled paragraph. */
export function askMarkdown(context: string): string {
  return askBlocks(context).map((b) => {
    if (b.kind === 'p') return b.label ? `**${b.label}:** ${b.text}` : b.text;
    const numbered = /^\d/.test(b.marks[0] ?? '');
    return b.items.map((it, i) => (numbered ? `${i + 1}. ${it}` : `- **(${b.marks[i]})** ${it}`)).join('\n');
  }).join('\n\n');
}
