// Run: node --test scripts/local-config.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './local-config.mjs';

const SCRIPT = new URL('./local-config.mjs', import.meta.url).pathname;
const block = (body) => `# prose\n\n\`\`\`maestro-config\n${body}\n\`\`\`\n\nmore prose\n`;
let home;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'lc-home-')); });

/** Runs the CLI with a throwaway HOME and a clean environment; returns { KEY: value } from its output. */
function show(env = {}, cwd = home) {
    const clean = { PATH: process.env.PATH, HOME: home };
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd, env: { ...clean, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.match(/^([\w ]+?):?\s+(.*)$/).slice(1, 3)));
}

const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

test('parseConfig reads only the maestro-config block, strips comments and quotes', () => {
    const c = parseConfig(block('overlay: my-skill   # trailing\ngh_org: "my-org"\nempty:\nledger_root: /a b/c'));
    assert.deepEqual(c, { overlay: 'my-skill', gh_org: 'my-org', ledger_root: '/a b/c' });
    assert.deepEqual(parseConfig('gh_org: nope\n'), {});
});

test('no config anywhere: everything unset, no overlay', () => {
    const v = show();
    assert.equal(v.overlay, '(none)');
    assert.equal(v.GH_ORG, '(unset)');
    assert.equal(v.LEDGER_ROOT, '(unset)');
});

test('user file at ~/.config/the-maestro/config.md is read', () => {
    write(join(home, '.config', 'the-maestro', 'config.md'), block('gh_org: user-org\nledger_root: /led'));
    const v = show();
    assert.equal(v.GH_ORG, 'user-org');
    assert.equal(v.LEDGER_ROOT, '/led');
});

test('MAESTRO_LOCAL_CONFIG beats the default path; empty string disables files', () => {
    write(join(home, '.config', 'the-maestro', 'config.md'), block('gh_org: default-org'));
    const explicit = join(home, 'x', 'mine.md');
    write(explicit, block('gh_org: explicit-org'));
    assert.equal(show({ MAESTRO_LOCAL_CONFIG: explicit }).GH_ORG, 'explicit-org');
    assert.equal(show({ MAESTRO_LOCAL_CONFIG: '' }).GH_ORG, '(unset)');
});

test('env beats user file beats overlay file', () => {
    write(join(home, '.claude', 'skills', 'o-skill', 'config.md'), block('gh_org: overlay-org\nproject: overlay-proj\nvault_root: /ov'));
    write(join(home, '.config', 'the-maestro', 'config.md'), block('overlay: o-skill\ngh_org: user-org'));
    const v = show({ VAULT_ROOT: '/env-vault' });
    assert.equal(v.GH_ORG, 'user-org');
    assert.equal(v.CONTAINER_PROJECT, 'overlay-proj');
    assert.equal(v.VAULT_ROOT, '/env-vault');
    assert.equal(show({ MAESTRO_GH_ORG: 'env-org' }).GH_ORG, 'env-org');
});

test('MAESTRO_OVERLAY beats overlay: in the file; sibling of the skill dir is found through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'lc-skills-'));
    const realSkill = join(root, 'checkout');
    mkdirSync(join(realSkill, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'skills'));
    symlinkSync(realSkill, join(root, 'skills', 'the-maestro'));
    write(join(root, 'skills', 'sib-skill', 'config.md'), block('gh_org: sibling-org'));
    write(join(home, '.config', 'the-maestro', 'config.md'), block('overlay: missing-skill'));
    // A script started through the symlink sees argv[1] under skills/the-maestro; emulate that.
    const viaModule = spawnSync(process.execPath, ['-e', `
        process.argv[1] = ${JSON.stringify(join(root, 'skills', 'the-maestro', 'scripts', 'x.mjs'))};
        const m = await import(${JSON.stringify(SCRIPT)});
        console.log(m.GH_ORG);`, '--input-type=module'], {
        encoding: 'utf8', cwd: home, env: { PATH: process.env.PATH, HOME: home, MAESTRO_OVERLAY: 'sib-skill' },
    });
    assert.equal(viaModule.stdout.trim(), 'sibling-org', viaModule.stderr);
});

test('plugin-qualified overlay resolves through installed_plugins.json', () => {
    const install = join(home, 'cache', 'plug', '1.0.0');
    write(join(install, 'skills', 'p-skill', 'config.md'), block('gh_org: plugin-org'));
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'plug@market': [{ scope: 'user', installPath: install }] } }));
    const v = show({ MAESTRO_OVERLAY: 'plug:p-skill' });
    assert.equal(v.GH_ORG, 'plugin-org');
    assert.equal(v.overlay, 'plug:p-skill');
    assert.equal(show({ MAESTRO_OVERLAY: 'other:p-skill' }).GH_ORG, '(unset)');
});

test('loop_patterns and resume_gh come from the file; the environment wins', () => {
    write(join(home, '.config', 'the-maestro', 'config.md'), block('loop_patterns: loop_a, loop_b\nresume_gh: off'));
    const v = show();
    assert.equal(v.LOOP_PATTERNS, 'loop_a, loop_b');
    assert.equal(v.RESUME_GH, 'off');
    const e = show({ MAESTRO_LOOP_PATTERNS: 'only_this', MAESTRO_RESUME_GH: 'on' });
    assert.equal(e.LOOP_PATTERNS, 'only_this');
    assert.equal(e.RESUME_GH, 'on');
    assert.equal(show({ MAESTRO_LOCAL_CONFIG: '' }).RESUME_GH, 'on');
});

test('approvals_review_day defaults to friday, reads the file, lowercases, and ignores a non-weekday', () => {
    assert.equal(show().APPROVALS_REVIEW_DAY, 'friday');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('approvals_review_day: Monday'));
    assert.equal(show().APPROVALS_REVIEW_DAY, 'monday');
    assert.equal(show({ MAESTRO_APPROVALS_REVIEW_DAY: 'wednesday' }).APPROVALS_REVIEW_DAY, 'wednesday');
    assert.equal(show({ MAESTRO_APPROVALS_REVIEW_DAY: 'someday' }).APPROVALS_REVIEW_DAY, 'friday');
});

test('watch_* keys: defaults, file values, environment wins, junk falls back', () => {
    const d = show();
    assert.deepEqual(
        [d.WATCH_MIN_INTERVAL, d.WATCH_MAX_INTERVAL, d.WATCH_QUIET_HOURS, d.WATCH_QUIET_HOURS_MODE, d.WATCH_QUIET_WEEKENDS],
        ['300', '1800', '20:00-07:00', 'stop', 'off'],
    );
    assert.equal(d.WATCH_TZ, Intl.DateTimeFormat().resolvedOptions().timeZone);
    write(join(home, '.config', 'the-maestro', 'config.md'), block(
        'watch_min_interval: 420\nwatch_max_interval: 900\nwatch_quiet_hours: 22:00-06:30\nwatch_quiet_hours_mode: slow\nwatch_quiet_weekends: on\nwatch_tz: America/New_York'));
    const f = show();
    assert.deepEqual(
        [f.WATCH_MIN_INTERVAL, f.WATCH_MAX_INTERVAL, f.WATCH_QUIET_HOURS, f.WATCH_QUIET_HOURS_MODE, f.WATCH_QUIET_WEEKENDS, f.WATCH_TZ],
        ['420', '900', '22:00-06:30', 'slow', 'on', 'America/New_York'],
    );
    assert.equal(show({ MAESTRO_WATCH_QUIET_HOURS_MODE: 'stop', MAESTRO_WATCH_TZ: 'UTC' }).WATCH_QUIET_HOURS_MODE, 'stop');
    const junk = show({ MAESTRO_WATCH_MIN_INTERVAL: 'fast', MAESTRO_WATCH_TZ: 'Not/AZone', MAESTRO_WATCH_QUIET_HOURS_MODE: 'later' });
    assert.equal(junk.WATCH_MIN_INTERVAL, '300');
    assert.equal(junk.WATCH_TZ, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(junk.WATCH_QUIET_HOURS_MODE, 'stop');
});

test('PR size budget: defaults, file values, env override, and bad values fall back', () => {
    const d = show();
    assert.equal(d.PR_MAX_CODE_FILES, '5');
    assert.equal(d.PR_MAX_CODE_LINES, '400');
    assert.equal(d.PR_TEST_GLOBS, '(unset)');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('pr_max_code_files: 8\npr_max_code_lines: 900\npr_test_globs: a/**, b/**\npr_mechanical_globs: *.lock'));
    const f = show();
    assert.equal(f.PR_MAX_CODE_FILES, '8');
    assert.equal(f.PR_MAX_CODE_LINES, '900');
    assert.equal(f.PR_TEST_GLOBS, 'a/**, b/**');
    assert.equal(f.PR_MECHANICAL_GLOBS, '*.lock');
    const e = show({ MAESTRO_PR_MAX_CODE_FILES: '3', MAESTRO_PR_MAX_CODE_LINES: 'lots', MAESTRO_PR_CONFIG_GLOBS: 'x.yml' });
    assert.equal(e.PR_MAX_CODE_FILES, '3');
    assert.equal(e.PR_MAX_CODE_LINES, '400', 'non-numeric env falls back to the default, not the file value');
    assert.equal(e.PR_CONFIG_GLOBS, 'x.yml');
});

test('twin_flow_repos: empty by default, list from the file, environment wins', () => {
    assert.equal(show().TWIN_FLOW_REPOS, '(unset)');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('twin_flow_repos: repo_a, repo_b'));
    assert.equal(show().TWIN_FLOW_REPOS, 'repo_a, repo_b');
    assert.equal(show({ MAESTRO_TWIN_FLOW_REPOS: 'only_one' }).TWIN_FLOW_REPOS, 'only_one');
    assert.equal(show({ MAESTRO_TWIN_FLOW_REPOS: '' }).TWIN_FLOW_REPOS, '(unset)');
});
