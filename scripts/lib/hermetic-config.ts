/**
 * Import this first in a test that must not see the user's config file. local-config.ts reads its files when it is first
 * loaded, so the switch has to be flipped before that import; ES modules evaluate in import order, which makes a leading
 * `import './lib/hermetic-config.ts'` enough where a top-level `await import()` would mean rewriting every import.
 */
process.env.MAESTRO_LOCAL_CONFIG = '';
