// Run: node --test scripts/local-config.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, numberMap, parseModelPrices, DEFAULT_COST_TARGETS } from './local-config.ts';

const SCRIPT = new URL('./local-config.ts', import.meta.url).pathname;
const block = (body: string): string => `# prose\n\n\`\`\`maestro-config\n${body}\n\`\`\`\n\nmore prose\n`;
let home = '';

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'lc-home-')); });

/** Runs the CLI with a throwaway HOME and a clean environment; returns { KEY: value } from its output. */
function show(env: Record<string, string> = {}, cwd: string = home): Record<string, string> {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home };
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd, env: { ...clean, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split('\n').map((l): [string, string] => {
        const m = l.match(/^([\w ]+?):?\s+(.*)$/);
        assert.ok(m, `unparsable line: ${l}`);
        return [m[1] ?? '', m[2] ?? ''];
    }));
}

const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

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

test('roll_* keys: defaults, file values, environment wins, junk falls back', () => {
    const d = show();
    assert.deepEqual([d.ROLL_TURNS, d.ROLL_READ_PER_TURN], ['180', '350000']);
    write(join(home, '.config', 'the-maestro', 'config.md'), block('roll_turns: 120\nroll_read_per_turn: 300000'));
    const f = show();
    assert.deepEqual([f.ROLL_TURNS, f.ROLL_READ_PER_TURN], ['120', '300000']);
    const e = show({ MAESTRO_ROLL_TURNS: '90' });
    assert.deepEqual([e.ROLL_TURNS, e.ROLL_READ_PER_TURN], ['90', '300000']);
    const junk = show({ MAESTRO_ROLL_TURNS: 'many', MAESTRO_ROLL_READ_PER_TURN: '-5' });
    assert.deepEqual([junk.ROLL_TURNS, junk.ROLL_READ_PER_TURN], ['180', '350000'], 'junk in the winning source falls back to the default');
});

test('roll_warn_pct / roll_at_pct: defaults, file values, environment wins, invalid values are rejected', () => {
    const pair = (o: Record<string, string> = {}) => { const v = show(o); return [v.ROLL_WARN_PCT, v.ROLL_AT_PCT]; };
    assert.deepEqual(pair(), ['85', '90']);
    write(join(home, '.config', 'the-maestro', 'config.md'), block('roll_warn_pct: 70\nroll_at_pct: 80'));
    assert.deepEqual(pair(), ['70', '80']);
    assert.deepEqual(pair({ MAESTRO_ROLL_AT_PCT: '95' }), ['70', '95'], 'env overrides one side');
    assert.deepEqual(pair({ MAESTRO_ROLL_WARN_PCT: '80' }), ['85', '90'], 'warn == roll rejects the pair');
    assert.deepEqual(pair({ MAESTRO_ROLL_WARN_PCT: '95' }), ['85', '90'], 'warn > roll rejects the pair');
    assert.deepEqual(pair({ MAESTRO_ROLL_AT_PCT: '60' }), ['85', '90'], 'roll below the file warn rejects the pair');
    for (const bad of ['0', '101', '-5', 'soon', '85.5', '']) {
        assert.deepEqual(pair({ MAESTRO_ROLL_WARN_PCT: bad, MAESTRO_ROLL_AT_PCT: '' }), ['85', '90'], `warn ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(pair({ MAESTRO_ROLL_AT_PCT: '101' }), ['70', '90'], 'out-of-range roll falls back alone when the pair stays ordered');
    assert.deepEqual(pair({ MAESTRO_ROLL_AT_PCT: '100' }), ['70', '100'], '100 is allowed');
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

test('PR body settings: defaults on, file values, env wins, bad values fall back', () => {
    const d = show();
    assert.equal(d.PR_BODY_SECTIONS, 'Context, Reviewer guide, Risk and blast radius, Rollback / flag, How to verify locally');
    for (const k of ['PR_BODY_CHECK_RISK', 'PR_BODY_CHECK_VERIFY', 'PR_BODY_CHECK_FORBIDDEN', 'PR_BODY_CHECK_DIAGRAM']) assert.equal(d[k], 'on', k);
    assert.equal(d.PR_DIAGRAM_MIN_FILES, '3');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('pr_body_sections: Context, Notes\npr_body_check_risk: off\npr_diagram_min_files: 6'));
    const f = show();
    assert.equal(f.PR_BODY_SECTIONS, 'Context, Notes');
    assert.equal(f.PR_BODY_CHECK_RISK, 'off');
    assert.equal(f.PR_BODY_CHECK_VERIFY, 'on');
    assert.equal(f.PR_DIAGRAM_MIN_FILES, '6');
    const e = show({ MAESTRO_PR_BODY_CHECK_RISK: 'on', MAESTRO_PR_BODY_CHECK_FORBIDDEN: 'false', MAESTRO_PR_DIAGRAM_MIN_FILES: 'many' });
    assert.equal(e.PR_BODY_CHECK_RISK, 'on');
    assert.equal(e.PR_BODY_CHECK_FORBIDDEN, 'off');
    assert.equal(e.PR_DIAGRAM_MIN_FILES, '3', 'a bad number falls back to the default, not the file value');
});

test('PR body private-reference and voice settings: defaults, file values, bad patterns dropped', () => {
    const d = show();
    assert.equal(d.PR_BODY_CHECK_PRIVATE, 'on');
    assert.equal(d.PR_BODY_CHECK_VOICE, 'on');
    assert.equal(d.PR_BODY_PRIVATE_PATTERNS, '(unset)');
    assert.equal(d.PR_BODY_VOICE_NAMES, '(unset)');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('pr_body_private_patterns: \\bX-\\d+\\b, (broken\npr_body_voice_names: Sam Fictional, samf\npr_body_check_voice: off'));
    const f = show();
    assert.equal(f.PR_BODY_PRIVATE_PATTERNS, '\\bX-\\d+\\b', 'an invalid regex is dropped');
    assert.equal(f.PR_BODY_VOICE_NAMES, 'Sam Fictional, samf');
    assert.equal(f.PR_BODY_CHECK_VOICE, 'off');
    assert.equal(show({ MAESTRO_PR_BODY_CHECK_PRIVATE: 'off' }).PR_BODY_CHECK_PRIVATE, 'off');
    assert.equal(d.PR_BODY_PRIVATE_WORDS, 'ledger, vault, Podium, orchestrator');
    assert.equal(show({ MAESTRO_PR_BODY_PRIVATE_WORDS: 'none' }).PR_BODY_PRIVATE_WORDS, '(unset)', 'none empties the word list');
    assert.equal(show({ MAESTRO_PR_BODY_PRIVATE_WORDS: 'memo' }).PR_BODY_PRIVATE_WORDS, 'memo');
});

test('review_queue_cap: default 4, file value, env wins, bad values fall back', () => {
    assert.equal(show().REVIEW_QUEUE_CAP, '4');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('review_queue_cap: 6'));
    assert.equal(show().REVIEW_QUEUE_CAP, '6');
    assert.equal(show({ MAESTRO_REVIEW_QUEUE_CAP: '2' }).REVIEW_QUEUE_CAP, '2');
    assert.equal(show({ MAESTRO_REVIEW_QUEUE_CAP: '0' }).REVIEW_QUEUE_CAP, '4');
    assert.equal(show({ MAESTRO_REVIEW_QUEUE_CAP: 'many' }).REVIEW_QUEUE_CAP, '4');
});

test('twin_flow_repos: empty by default, list from the file, environment wins', () => {
    assert.equal(show().TWIN_FLOW_REPOS, '(unset)');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('twin_flow_repos: repo_a, repo_b'));
    assert.equal(show().TWIN_FLOW_REPOS, 'repo_a, repo_b');
    assert.equal(show({ MAESTRO_TWIN_FLOW_REPOS: 'only_one' }).TWIN_FLOW_REPOS, 'only_one');
    assert.equal(show({ MAESTRO_TWIN_FLOW_REPOS: '' }).TWIN_FLOW_REPOS, '(unset)');
});

test('copilot_orgs: empty by default, list from the file, environment wins', () => {
    assert.equal(show().COPILOT_ORGS, '(unset)');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('copilot_orgs: org_a, org_b'));
    assert.equal(show().COPILOT_ORGS, 'org_a, org_b');
    assert.equal(show({ MAESTRO_COPILOT_ORGS: 'only_one' }).COPILOT_ORGS, 'only_one');
});

test('branch sweep settings: defaults, file values, environment wins, bad idle falls back', () => {
    const d = show();
    assert.equal(d.GIT_EMAILS, '(unset)');
    assert.equal(d.PROTECTED_BRANCHES, 'main, master, staging, develop, release/*, staging/*, hotfix/*');
    assert.equal(d.SWEEP_MERGE_TARGETS, '(unset)');
    assert.equal(d.SWEEP_IDLE_MINUTES, '60');
    assert.equal(d.SWEEP_BUDGET_SECONDS, '300');
    assert.equal(d.AGENT_OWNED_REPOS, '(unset)');
    assert.equal(show({ MAESTRO_AGENT_OWNED_REPOS: '~/tools, /abs/notes' }).AGENT_OWNED_REPOS, `${home}/tools, /abs/notes`, 'a leading ~/ is expanded');
    assert.equal(d.TRACKER_KEY_PATTERN, '\\b[A-Z][A-Z0-9]+-\\d+\\b');
    assert.equal(show({ MAESTRO_TRACKER_KEY_PATTERN: '\\bAH-\\d+\\b' }).TRACKER_KEY_PATTERN, '\\bAH-\\d+\\b');
    assert.equal(show({ MAESTRO_TRACKER_KEY_PATTERN: '(' }).TRACKER_KEY_PATTERN, '\\b[A-Z][A-Z0-9]+-\\d+\\b', 'an invalid pattern falls back');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('git_emails: a@example.com, b@example.com\nprotected_branches: main, release/*, backmerge/*\nsweep_merge_targets: repo_a=develop|staging, repo_b=main\nsweep_idle_minutes: 15\nsweep_budget_seconds: 90'));
    const f = show();
    assert.equal(f.GIT_EMAILS, 'a@example.com, b@example.com');
    assert.equal(f.PROTECTED_BRANCHES, 'main, release/*, backmerge/*');
    assert.equal(f.SWEEP_MERGE_TARGETS, 'repo_a=develop|staging, repo_b=main');
    assert.equal(f.SWEEP_IDLE_MINUTES, '15');
    assert.equal(f.SWEEP_BUDGET_SECONDS, '90');
    const e = show({ MAESTRO_GIT_EMAILS: 'c@example.com', MAESTRO_SWEEP_IDLE_MINUTES: 'soon' });
    assert.equal(e.GIT_EMAILS, 'c@example.com');
    assert.equal(e.SWEEP_IDLE_MINUTES, '60');
});

test('event loop settings: argv lists parse from JSON, junk is ignored, the dir defaults under the ledger root', () => {
    write(join(home, '.config', 'the-maestro', 'config.md'), block('ledger_root: /led\nnotify_command: ["send", "--to-me"]\ninbox_command: not json'));
    const v = show();
    assert.equal(v.EVENT_DIR, '/led/Events');
    assert.equal(v.NOTIFY_COMMAND, '(set)');
    assert.equal(v.INBOX_COMMAND, '(unset)');
    assert.equal(show({ MAESTRO_EVENT_DIR: '/elsewhere' }).EVENT_DIR, '/elsewhere');
});

test('scripts_dir is unset by default, reads the file, expands ~/, and the environment wins', () => {
    assert.equal(show().SCRIPTS_DIR, '(unset)');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('scripts_dir: /shelf'));
    assert.equal(show().SCRIPTS_DIR, '/shelf');
    assert.equal(show({ MAESTRO_SCRIPTS_DIR: '~/my-shelf' }).SCRIPTS_DIR, join(home, 'my-shelf'));
    assert.equal(show({ MAESTRO_SCRIPTS_DIR: '' }).SCRIPTS_DIR, '(unset)');
});

test('numberMap reads k=v, k: v and brace forms, and drops anything that is not a positive number', () => {
    assert.deepEqual(numberMap('opus=1, sonnet=0.2'), { opus: 1, sonnet: 0.2 });
    assert.deepEqual(numberMap('{opus: 1, "haiku": 0.07}'), { opus: 1, haiku: 0.07 });
    assert.deepEqual(numberMap('opus=1, sonnet=free, haiku=-3, other=0, =4, junk'), { opus: 1 });
    assert.deepEqual(numberMap(''), {});
});

test('cost_targets overrides defaults key by key; junk keeps the default; no prices is unset', () => {
    const d = show();
    assert.equal(d.COST_TARGETS, Object.entries(DEFAULT_COST_TARGETS).map(([k, v]) => `${k}=${v}`).join(', '));
    assert.equal(d.MODEL_PRICES, '(unset)');
    assert.match(d.COST_TARGETS, /opus_priced_share_max=50/);
    const o = show({ MAESTRO_COST_TARGETS: 'opus_share_max=30, haiku_share_min=lots' });
    assert.match(o.COST_TARGETS, /opus_share_max=30, haiku_share_min=15,/);
    write(join(home, '.config', 'the-maestro', 'config.md'), block('cost_targets: wakes_per_prompt_max=0.4   # tighter'));
    const f = show();
    assert.match(f.COST_TARGETS, /wakes_per_prompt_max=0.4,/);
});

const PRICES = 'opus: input=4, cache_write_5m=5, cache_write_1h=8, cache_read=0.2, output=20; sonnet: input=2, cache_write_5m=2.5, cache_write_1h=4, cache_read=0.2, output=10; haiku: input=1, cache_write_5m=1.25, cache_write_1h=2, cache_read=0.1, output=5';

test('numberMap keys may carry digits, as in cache_write_5m', () => {
    assert.deepEqual(numberMap('cache_write_5m=5, cache_write_1h=8'), { cache_write_5m: 5, cache_write_1h: 8 });
});

test('parseModelPrices reads per-family groups, defaults the 1h write to the 5m price, and drops an incomplete family', () => {
    const p = parseModelPrices(`${PRICES}; fable: input=4, output=20`);
    assert.deepEqual(Object.keys(p), ['opus', 'sonnet', 'haiku']);
    assert.deepEqual(p.opus, { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 });
    assert.equal(parseModelPrices('other: input=1, cache_write_5m=2, cache_read=0.1, output=5').other.cache_write_1h, 2);
    assert.deepEqual(parseModelPrices(''), {});
});

test('model_prices needs opus, sonnet and haiku; no prices are built in', () => {
    assert.equal(show().MODEL_PRICES, '(unset)');
    assert.equal(show({ MAESTRO_MODEL_PRICES: PRICES.split('; haiku')[0] }).MODEL_PRICES, '(unset)');
    assert.match(show({ MAESTRO_MODEL_PRICES: PRICES }).MODEL_PRICES, /^opus\(input=4 cache_write_5m=5 cache_write_1h=8 cache_read=0\.2 output=20\); sonnet\(/);
    write(join(home, '.config', 'the-maestro', 'config.md'), block(`model_prices: ${PRICES}   # fetched 2026-10-02`));
    assert.match(show().MODEL_PRICES, /haiku\(input=1 cache_write_5m=1\.25 cache_write_1h=2 cache_read=0\.1 output=5\)$/);
});

test('update_check is on and auto_pull is off by default; the file and the environment change them', () => {
    const d = show();
    assert.deepEqual([d.UPDATE_CHECK, d.AUTO_PULL], ['on', 'off']);
    write(join(home, '.config', 'the-maestro', 'config.md'), block('update_check: off\nauto_pull: on'));
    const f = show();
    assert.deepEqual([f.UPDATE_CHECK, f.AUTO_PULL], ['off', 'on']);
    const e = show({ MAESTRO_UPDATE_CHECK: 'yes', MAESTRO_AUTO_PULL: 'no' });
    assert.deepEqual([e.UPDATE_CHECK, e.AUTO_PULL], ['on', 'off']);
});

test('auto_pull set-ness is separate from its value: unset and off both read off, only a recognised word counts as set', () => {
    const cfg = join(home, '.config', 'the-maestro', 'config.md');
    const read = (env: Record<string, string> = {}) => { const r = show(env); return [r.AUTO_PULL, r.AUTO_PULL_SET]; };
    assert.deepEqual(read(), ['off', 'no']);
    assert.deepEqual(read({ MAESTRO_AUTO_PULL: 'on' }), ['on', 'yes']);
    assert.deepEqual(read({ MAESTRO_AUTO_PULL: 'off' }), ['off', 'yes']);
    assert.deepEqual(read({ MAESTRO_AUTO_PULL: 'maybe' }), ['off', 'no']);
    assert.deepEqual(read({ MAESTRO_AUTO_PULL: '' }), ['off', 'no']);
    write(cfg, block('auto_pull: on'));
    assert.deepEqual(read(), ['on', 'yes']);
    write(cfg, block('auto_pull: off   # decided'));
    assert.deepEqual(read(), ['off', 'yes']);
    assert.deepEqual(read({ MAESTRO_AUTO_PULL: 'on' }), ['on', 'yes']);
    write(cfg, block('auto_pull:\n# auto_pull: on'));
    assert.deepEqual(read(), ['off', 'no']);
});

test('auto_pull set in the overlay config counts as set', () => {
    const skills = join(home, '.claude', 'skills');
    write(join(skills, 'acme-overlay', 'config.md'), block('auto_pull: off'));
    write(join(home, '.config', 'the-maestro', 'config.md'), block('overlay: acme-overlay'));
    assert.deepEqual([show().AUTO_PULL, show().AUTO_PULL_SET], ['off', 'yes']);
});

test('projects_dir: unset follows container_root, not the working directory; an explicit value wins', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'lc-elsewhere-'));
    const fromCwd = show({}, elsewhere).CLAUDE_PROJECTS_DIR ?? '';
    assert.ok(fromCwd.endsWith(elsewhere.replace(/[\\/]/g, '-')), 'no container_root: the working directory, as before');
    const container = join(home, 'work', 'my-container');
    const viaRoot = show({ MAESTRO_CONTAINER_ROOT: container }, elsewhere).CLAUDE_PROJECTS_DIR ?? '';
    assert.equal(viaRoot, join(home, '.claude', 'projects', container.replace(/[\\/]/g, '-')));
    const viaTilde = show({ MAESTRO_CONTAINER_ROOT: '~/work/my-container' }, elsewhere).CLAUDE_PROJECTS_DIR ?? '';
    assert.equal(viaTilde, viaRoot, 'a leading ~/ is expanded');
    assert.equal(show({ MAESTRO_CONTAINER_ROOT: container, MAESTRO_PROJECTS_DIR: '/explicit/dir' }, elsewhere).CLAUDE_PROJECTS_DIR, '/explicit/dir');
});

test('status page settings: unset means nothing hardcoded; the file and the environment set them', () => {
    const none = show();
    assert.equal(none.STATUS_DIR, '(unset)');
    assert.equal(none.STATUS_STREAMS, '(unset)');
    assert.equal(none.TRACKER_URL_BASE, '(unset)');
    assert.equal(none.TICKET_NOTE_PATH, 'Projects/{prefix}/Tickets/{id}');
    write(join(home, '.config', 'the-maestro', 'config.md'), block('vault_root: /v/MyVault\nstatus_streams: Alpha, Beta\nstatus_repo_streams: api=Alpha, web=Beta\nobsidian_vault: Named'));
    const v = show();
    assert.equal(v.STATUS_STREAMS, 'Alpha, Beta');
    assert.equal(v.STATUS_REPO_STREAMS, 'api=Alpha, web=Beta');
    assert.equal(v.OBSIDIAN_VAULT, 'Named');
    assert.equal(show({ MAESTRO_OBSIDIAN_VAULT: '' }).OBSIDIAN_VAULT, 'MyVault', 'falls back to the vault_root folder name');
    assert.equal(show({ MAESTRO_STATUS_DIR: '/s' }).STATUS_DIR, '/s');
});
