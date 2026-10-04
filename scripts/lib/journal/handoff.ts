import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { keptCounts } from '../../branch-sweep.ts';
import { sessionLine } from '../../token-metrics.ts';
import { BOX, classify, isStale, daysBetween } from '../boxes.ts';
import { isOpen } from '../ledger-core.ts';
import { approvalMap } from './approvals.ts';
import { clip, itemText } from './format.ts';
import { LEARNING, TICKET_ID } from './retro.ts';
import type { WorktreeSweep } from '../../branch-sweep.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import type { BoardContext } from './board.ts';

/** What the handoff draft reads from the run: the ledger, its fold, the clock and the transcript directory for the session line. */
export interface HandoffContext { fold: BoardContext['fold']; readLedger: () => LedgerRow[]; today: () => string; claudeProjectsDir: string }
/** A PR, ref, ticket or path an item mentions. */
export interface Artifact { kind: string; v: string }
type KeptWorktree = { path: string; repo: string; reason: string };

export const PATH_LIKE = /(?:^|[\s(`'"])((?:~\/|\.{1,2}\/|\/)[\w.@~+-]+(?:\/[\w.@~+-]+)*(?::\d+)?|[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,6}(?::\d+)?)(?=[\s),.;:`'"]|$)/g;
export const yesterday = (): string => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

/** PR numbers, refs, tickets and file paths mentioned by a set of items, each listed once. */
export function artifactsOf(items: LedgerItem[]): Artifact[] {
    const found = new Map<string, Artifact>();
    const add = (kind: string, v: string): void => { found.set(`${kind} ${v}`, { kind, v }); };
    for (const i of items) {
        const text = itemText(i);
        for (const r of i.refs || []) add(/^#\d+$/.test(r) ? 'pr' : 'ref', r);
        for (const n of text.match(/#\d{2,}/g) || []) add('pr', n);
        if (i.ticket) add('ticket', i.ticket);
        for (const t of text.match(TICKET_ID) || []) add('ticket', t);
        for (const m of text.matchAll(PATH_LIKE)) add('path', m[1]);
    }
    return [...found.values()];
}

/**
 * The worktrees the roll sweep keeps. One line each by default; with `summary` (a sweep result, used by `handoff --all`,
 * where there can be hundreds) it is the sweep's totals and the kept ones as counts by reason.
 */
export function cleanupWorktreeLines(kept: KeptWorktree[], summary: WorktreeSweep | null): string[] {
    if (summary) {
        return [`Worktree sweep (dry run): ${summary.removed.length} would be removed, ${summary.pruned.length} pruned, ${kept.length} kept. Kept, by reason (\`--verbose\` lists them):`, '',
            ...keptCounts(kept).map((c) => `- ${c.label}: ${c.count}`), ...(summary.skipped?.length ? ['', `Sweep budget reached: skipped ${summary.skipped.join(', ')}.`] : []), ''];
    }
    return kept.length ? ['Worktrees the roll sweep keeps, because they hold work or are in use:', '', ...kept.map((k) => `- \`${k.path}\` (${k.repo}): ${k.reason}`), ''] : [];
}

/** `stream` is a stream name, or null for every stream (`handoff --all`): items then carry their stream in the meta tail. */
export function handoffText(ctx: HandoffContext, stream: string | null, since: string, keptWorktrees: KeptWorktree[] = [], { learn = '', next = '', sweep = null, verbose = false }: { learn?: string; next?: string; sweep?: WorktreeSweep | null; verbose?: boolean } = {}): string {
    const { fold, readLedger, today, claudeProjectsDir: CLAUDE_PROJECTS_DIR } = ctx;
    const items = fold(readLedger()).items.filter((i) => stream === null || i.stream === stream);
    const d = today();
    const onOrAfter = (day: string | undefined): boolean => day !== undefined && day >= since;
    const recent = (i: LedgerItem): boolean => onOrAfter(i.closedBy?.date || i.date) || onOrAfter(i.date);
    const open = items.filter((i) => isOpen(i) && (i.kind === 'wip' || i.kind === 'blocked'));
    const doneRecently = items.filter((i) => i.state === 'done' && onOrAfter(i.closedBy?.date || i.date));
    const approvals = approvalMap(readLedger());
    const boxOf = (i: LedgerItem): number => classify(i, approvals.get(i.id ?? ''));
    // Every open question is listed: paste blocks apart, everything else (whatever box triage gives it) under Needs Jack.
    const asks = items.filter((i) => isOpen(i) && (i.kind === 'question' || i.kind === 'decision'));
    const pasteBlocks = asks.filter((i) => boxOf(i) === BOX.PASTE);
    const needsJack = asks.filter((i) => boxOf(i) !== BOX.PASTE);
    const learnings = items.filter((i) => recent(i) && LEARNING.test(itemText(i)));
    const touched = items.filter((i) => isOpen(i) || recent(i));
    const arts = artifactsOf(touched);
    const meta = (i: LedgerItem): string => [stream === null && i.stream && `stream: ${i.stream}`, i.repo, i.ticket && `[[${i.ticket}]]`, i.gate && `gate: ${i.gate}`].filter(Boolean).join(' · ');
    const line = (i: LedgerItem, tag: string | undefined): string => `- \`${i.id}\` [${tag}] ${clip(itemText(i), 200)}${meta(i) ? ` — ${meta(i)}` : ''}`;
    const one = (kind: string): string[] => arts.filter((a) => a.kind === kind).map((a) => a.v);

    return [
        '---', 'status: draft', `stream: ${stream ?? 'all'}`, `generated: ${d}`, `since: ${since}`, 'type: handoff', '---', '',
        `# ${stream ?? 'All streams'} handoff, ${d}`, '',
        '> Scaffolded by `journal.mjs handoff` from the ledger. Sections 1, 3 and 4 are derived (4 from boxes 4 and 5: questions for the user, and paste blocks with their files); 2 and 5 need the author. A fresh session runs `journal.mjs resume`, and calls `ListAgents` itself.', '',
        '## Session metrics', '', sessionLine(CLAUDE_PROJECTS_DIR), '',
        '## 1. Tasks with status', '',
        ...(open.length || doneRecently.length ? [
            ...open.map((i) => line(i, i.kind === 'blocked' ? 'blocked' : 'in flight')),
            ...doneRecently.map((i) => line(i, `done ${i.closedBy?.date || i.date}`)),
        ] : ['_none_']), '',
        '## 2. Learnings, including what was ruled out', '',
        ...(learn ? [`- ${learn}`] : []),
        ...(learnings.length ? learnings.map((i) => line(i, i.kind)) : learn ? [] : ['_None matched learned, lesson, ruled out or cause. Write what was ruled out here._']), '',
        '## 3. Artifacts', '',
        ...(arts.length ? [
            ...(one('pr').length ? [`- PRs: ${one('pr').join(', ')}`] : []),
            ...(one('ticket').length ? [`- Tickets: ${one('ticket').join(', ')}`] : []),
            ...(one('ref').length ? [`- Refs: ${one('ref').join(', ')}`] : []),
            ...(one('path').length ? [`- Paths: ${one('path').join(', ')}`] : []),
        ] : ['_none_']), '',
        '## 4. Decisions awaiting', '',
        ...(needsJack.length || pasteBlocks.length ? [
            ...(needsJack.length ? ['**Needs Jack**', '', ...needsJack.map((i) => `${line(i, i.kind)}${isStale(BOX.NEEDS_JACK, i, d) ? ` (stale: ${daysBetween(i.date, d)}d)` : ''}`), ''] : []),
            ...(pasteBlocks.length ? ['**Paste blocks for Jack**', '', ...pasteBlocks.map((i) => `${line(i, 'paste')} — ${i.paste ? `block: ${i.paste}` : 'no block file'}${isStale(BOX.PASTE, i, d) ? ` (stale: ${daysBetween(i.date, d)}d)` : ''}`)] : []),
        ] : ['_none_']), '',
        '## 5. Next concrete action', '',
        next || '_Author: one concrete first step for the fresh session._', '',
        '## Cleanup candidates', '',
        '_Run `node scripts/branch-sweep.ts` and paste its table here (remote branches need approval; `roll` removes qualifying worktrees on its own)._', '',
        ...cleanupWorktreeLines(keptWorktrees, sweep && stream === null && !verbose ? sweep : null),
        'Then run `journal.mjs resume` and verify: ledger status, open PRs, running loops, and `ListAgents`.', '',
    ].join('\n');
}

/**
 * Points a project CONTEXT.md at the handoff just written, with one `Latest handoff: [[<note>]] (<date>)` line: an existing
 * line is replaced, otherwise it goes under the first heading (or at the top, after any YAML frontmatter). Running it again for the same note on the same day changes nothing.
 * A missing file is reported and fails the command; nothing else in the file is touched.
 */
export function updateContextLink(ctx: Pick<HandoffContext, 'today'>, file: string, handoffPath: string): void {
    const { today } = ctx;
    if (!existsSync(file)) { console.error(`--update-context: ${file} does not exist; the handoff was written but nothing was linked.`); process.exitCode = 1; return; }
    const link = `Latest handoff: [[${basename(handoffPath, '.md')}]] (${today()})`;
    const text = readFileSync(file, 'utf8');
    const front = text.match(/^---\n[\s\S]*?\n---\n/)?.[0] || ''; // YAML frontmatter stays first
    const body = text.slice(front.length);
    const next = /^Latest handoff:.*$/m.test(text) ? text.replace(/^Latest handoff:.*$/m, () => link)
        : /^# .*$/m.test(body) ? front + body.replace(/^# .*$/m, (h) => `${h}\n\n${link}`) : `${front}${link}\n\n${body}`;
    if (next !== text) writeFileSync(file, next);
    console.log(`${next === text ? 'already linked' : 'linked'} ${file} -> ${basename(handoffPath, '.md')}`);
}
