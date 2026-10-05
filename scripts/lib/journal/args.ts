/** Command-line parsing for journal: flags, boolean flags and positionals. Pure: it reads only the argv it is given. */
const BOOL_FLAGS = new Set(['--json', '--dry-run', '--full', '--open', '--allow-unmarked', '--new-stream', '--force', '--include-archived', '--footer', '--apply', '--strict', '--fast', '--verbose', '--all', '--update-context', '--pending', '--snapshot']);
export interface Args {
    /** The value after `--name`, or `fallback` when the flag is absent or followed by another flag. */
    arg(name: string): string | null;
    arg(name: string, fallback: string): string;
    has(name: string): boolean;
    /** The words after the command that are neither flags nor flag values. */
    positional: string[];
}

export function parseArgs(argv: string[]): Args {
    function isFlagValue(a: string): boolean {
        const i = argv.indexOf(a);
        return i > 0 && argv[i - 1].startsWith('--') && !BOOL_FLAGS.has(argv[i - 1]);
    }
    const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));
    function arg(name: string): string | null;
    function arg(name: string, fallback: string): string;
    function arg(name: string, fallback: string | null = null): string | null {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
    }
    const has = (name: string): boolean => argv.includes(`--${name}`);
    return { arg, has, positional };
}
