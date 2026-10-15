/**
 * Memory sort: decide whether a memory file is a project fact (belongs on a library page) or a rule about working with the user
 * (stays in memory). Pure functions over file text; nothing here reads or writes the disk.
 */

export type Kind = 'project-fact' | 'behaviour-rule' | 'decision-or-status' | 'unsure';

export interface MemoryFile { name: string; text: string }

export interface Sorted {
    name: string;
    kind: Kind;
    /** The project whose library page should hold the fact; null unless kind is project-fact. */
    repo: string | null;
    /** Vault-relative target page, null unless kind is project-fact. */
    page: string | null;
    why: string;
}

/** A project name looked for in a file's name and description: the pattern, then the library project it maps to. */
export type RepoHint = [RegExp, string];

/** Used when the caller passes no hints, first match wins. A private install adds its own with `--hints` (see readHints in memory-sort.ts). */
export const DEFAULT_HINTS: RepoHint[] = [
    [/the-maestro|maestro|podium|event loop|event-loop|\bledger\b|library/i, 'the-maestro'],
    [/mithril/i, 'mithril'],
    [/\.env|env-where|registry|npmrc|iMessage|dev-env/i, 'dev-env'],
];

/** A decision, a definition or a dated status: the library holds a pointer to DECISIONS.md for these, never the status itself. */
const DECISION_WORDS = /vision|definition|defined|week of|\bended\b|handed|frozen|goals|experiment/i;

const BEHAVIOUR_WORDS = /\b(don'?t|never|always|from now on|re-?raise|prefer|standing|permission|approved|decided)\b/i;

export function readHeader(text: string): { type: string; description: string; body: string } {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const head = m?.[1] ?? '';
    const type = /^\s{2}type:\s*(\S+)/m.exec(head)?.[1] ?? '';
    const description = (/^description:\s*(.*)$/m.exec(head)?.[1] ?? '').replace(/^"|"$/g, '');
    return { type, description, body: m?.[2] ?? text };
}

function repoFor(name: string, description: string, hints: RepoHint[]): string | null {
    const hay = `${name} ${description}`;
    for (const [re, repo] of hints) if (re.test(hay)) return repo;
    return null;
}

/** Sort one memory file. A decision tree on the file's own `type` plus the project it names; it never reads the body for the verdict. */
export function sortMemory(file: MemoryFile, hints: RepoHint[] = DEFAULT_HINTS): Sorted {
    const { type, description } = readHeader(file.text);
    const repo = repoFor(file.name, description, hints);
    const behaviour = BEHAVIOUR_WORDS.test(description);
    const fact = (r: string, why: string): Sorted => ({ name: file.name, kind: 'project-fact', repo: r, page: `Projects/${r}/Knowledge/${file.name}.md`, why });
    const other = (kind: Kind, why: string): Sorted => ({ name: file.name, kind, repo: null, page: null, why });

    if ((type === 'project' || type === 'reference') && DECISION_WORDS.test(`${file.name} ${description}`)) return other('decision-or-status', `typed ${type}, reads as a decision or dated status: a pointer to DECISIONS.md, not a fact page`);
    if (type === 'feedback') return other('behaviour-rule', 'typed feedback: how to work with the user');
    if ((type === 'project' || type === 'reference') && repo && !behaviour) return fact(repo, `typed ${type}, names ${repo}`);
    if ((type === 'project' || type === 'reference') && repo) return other('unsure', `typed ${type} naming ${repo}, but worded as a rule: the user decides`);
    if (type === 'project' || type === 'reference') return other(behaviour ? 'behaviour-rule' : 'unsure', `typed ${type}, names no project`);
    return other('unsure', 'no recognised type in the frontmatter');
}

export function sortAll(files: MemoryFile[], hints: RepoHint[] = DEFAULT_HINTS): Sorted[] {
    return files.filter((f) => f.name !== 'MEMORY').map((f) => sortMemory(f, hints)).sort((a, b) => a.name.localeCompare(b.name));
}
