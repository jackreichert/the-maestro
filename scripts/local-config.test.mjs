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
