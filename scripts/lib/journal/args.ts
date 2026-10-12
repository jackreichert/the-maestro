/** Command-line parsing for journal: flags, boolean flags and positionals. Pure: it reads only the argv it is given. */
const BOOL_FLAGS = new Set(['--json', '--dry-run', '--full', '--open', '--allow-unmarked', '--new-stream', '--force', '--include-archived', '--footer', '--apply', '--strict', '--fast', '--verbose', '--all', '--update-context', '--pending', '--snapshot', '--neighbors', '--include-superseded', '--no-miss', '--how-do-i', '--check', '--new']);
export interface Args {
    /** The value after `--name`, or `fallback` when the flag is absent or followed by another flag. */
    arg(name: string): string | null;
    arg(name: string, fallback: string): string;
    has(name: string): boolean;
    /** The words after the command that are neither flags nor flag values. */
    positional: string[];
}

export function parseArgs(argv: string[]): Args {
    // A bare `--` ends the flags: everything after it is literal text, so `log -- --help` logs the words `--help`.
    const stop = argv.indexOf('--');
    const flags = stop === -1 ? argv : argv.slice(0, stop);
    const literal = stop === -1 ? [] : argv.slice(stop + 1);
    function isFlagValue(a: string): boolean {
        const i = flags.indexOf(a);
        return i > 0 && flags[i - 1].startsWith('--') && !BOOL_FLAGS.has(flags[i - 1]);
    }
    const positional = [...flags.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a)), ...literal];
    function arg(name: string): string | null;
    function arg(name: string, fallback: string): string;
    function arg(name: string, fallback: string | null = null): string | null {
        const i = flags.indexOf(`--${name}`);
        return i !== -1 && flags[i + 1] && !flags[i + 1].startsWith('--') ? flags[i + 1] : fallback;
    }
    const has = (name: string): boolean => flags.includes(`--${name}`);
    return { arg, has, positional };
}
