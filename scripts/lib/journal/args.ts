/** Command-line parsing for journal: flags, boolean flags and positionals. Pure: it reads only the argv it is given. */
const BOOL_FLAGS = new Set(['--json', '--dry-run', '--full', '--open', '--allow-unmarked', '--new-stream', '--force', '--include-archived', '--footer', '--apply', '--strict', '--fast', '--verbose', '--all', '--update-context', '--pending']);
export function parseArgs(argv) {
    function isFlagValue(a) {
        const i = argv.indexOf(a);
        return i > 0 && argv[i - 1].startsWith('--') && !BOOL_FLAGS.has(argv[i - 1]);
    }
    const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));
    function arg(name, fallback = null) {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
    }
    const has = (name) => argv.includes(`--${name}`);
    return { arg, has, positional };
}
