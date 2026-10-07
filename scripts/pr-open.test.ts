// Run: node --test scripts/pr-open.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { bodyProblems, type BodyRules } from './pr-body.ts';

const SCRIPT = new URL('./pr-open.ts', import.meta.url).pathname;

const git = (repo: string, ...args: string[]): void => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
};
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `x${i}`).join('\n') + '\n';
const put = (repo: string, path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };

/** A repo with a feature branch holding `files`, plus a fake gh that logs its argv to <repo>/gh.log. */
function fixture(files: Record<string, string>) {
    const repo = mkdtempSync(join(tmpdir(), 'pr-open-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    put(repo, 'README.keep', 'keep\n');
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    for (const [p, t] of Object.entries(files)) put(repo, p, t);
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'change');
    const log = join(tmpdir(), `gh-${Math.random().toString(36).slice(2)}.log`);
    const gh = join(repo, '..', `fake-gh-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(gh, 0o755);
    return { repo, log, gh };
}

const NONE: BodyRules = { sections: [], risk: false, verify: false, forbidden: false, diagram: false, diagramMinFiles: 3 };
const TWO: BodyRules = { ...NONE, sections: ['Context', 'Reviewer guide'] };
const GOOD_BODY = [
    '## Context', 'Why this exists and what changed.',
    '## Reviewer guide', '- Look at pr-open.ts first; the rest is mechanical.',
    '## Risk and blast radius', 'Risk: low - internal tool only.',
    '## Rollback / flag', 'Plain revert.',
    '## How to verify locally', '```bash', 'npm test', '```', 'Expected: all pass.', '',
].join('\n');

/** A body file next to the repo; `open` supplies a valid one unless the test passes its own --body-file. */
const bodyFile = (repo: string, text: string): string => { const p = join(repo, '..', `body-${Math.random().toString(36).slice(2)}.md`); writeFileSync(p, text); return p; };

const open = ({ repo, gh }: { repo: string; gh: string }, extra: string[] = []) => spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--title', 'T', ...(extra.includes('--body-file') || extra.includes('--no-body') ? [] : ['--body-file', bodyFile(repo, GOOD_BODY)]), ...extra.filter((a) => a !== '--no-body')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: repo, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH_BIN: gh },
});

test('over budget refuses, prints the summary and a split hint, and never calls gh', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    const r = open(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /verdict:\s+FAIL/);
    assert.match(r.stderr, /split plan/);
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('code mixed with a lockfile refuses and never calls gh', () => {
    const f = fixture({ 'src/a.py': lines(3), 'uv.lock': lines(50) });
    const r = open(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /mechanical changes go in their own PR/);
    assert.ok(!existsSync(f.log));
});

test('under budget calls gh with --draft and --assignee @me plus the passthrough flags', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    const body = bodyFile(f.repo, GOOD_BODY);
    const r = open(f, ['--body-file', body, '--head', 'feature']);
    assert.equal(r.status, 0, r.stderr);
    const call = readFileSync(f.log, 'utf8').trim();
    assert.equal(call, `pr create --draft --assignee @me --base main --title T --body-file ${body} --head feature`);
});

test('draft and assignee cannot be turned off or overridden', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    for (const flag of [['--no-draft'], ['--draft=false'], ['--assignee', 'someone'], ['--ready']]) {
        const r = open(f, flag);
        assert.equal(r.status, 2, flag.join(' '));
    }
    assert.ok(!existsSync(f.log));
});

test('--dry-run prints the gh command and does not run gh; an over-budget dry run still refuses', () => {
    const ok = fixture({ 'src/a.py': lines(10) });
    const r = open(ok, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pr create --draft --assignee @me --base main --title T/);
    assert.ok(!existsSync(ok.log));
    const big = fixture({ 'src/big.py': lines(500) });
    assert.equal(open(big, ['--dry-run']).status, 1);
});

test('inherited object keys are unknown arguments, not passthrough flags', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    for (const key of ['constructor', 'toString']) {
        const r = open(f, [key]);
        assert.equal(r.status, 2, key);
        assert.match(r.stderr, new RegExp(`unknown argument ${key}`));
    }
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('a missing --body-file refuses and never calls gh, even on a dry run', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    for (const extra of [['--no-body'], ['--no-body', '--dry-run']]) {
        const r = open(f, extra);
        assert.equal(r.status, 1, extra.join(' '));
        assert.match(r.stderr, /--body-file is required/);
    }
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('an unreadable --body-file is a usage error and never calls gh', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    const r = open(f, ['--body-file', join(f.repo, 'nope.md')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read --body-file/);
    assert.ok(!existsSync(f.log));
});

test('a body without both sections refuses, names what is missing, and never calls gh', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    const cases: [string, RegExp][] = [
        ['just prose\n', /missing a "## Context" section; missing a "## Reviewer guide" section/],
        ['## Context\n\nWhy.\n', /missing a "## Reviewer guide" section/],
        ['## Reviewer guide\n\nLook here.\n', /missing a "## Context" section/],
        ['## Context\n\nWhy.\n\n## Reviewer guide\n\n_TBD_\n', /"## Reviewer guide" has no content/],
    ];
    for (const [text, expected] of cases) {
        const r = open(f, ['--body-file', bodyFile(f.repo, text)]);
        assert.equal(r.status, 1, text);
        assert.match(r.stderr, expected);
    }
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('a body-less PR also refuses on --dry-run, and a valid body passes it', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    assert.equal(open(f, ['--dry-run', '--body-file', bodyFile(f.repo, '## Context\n')]).status, 1);
    const ok = open(f, ['--dry-run']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /--body-file .*body-/);
});

test('bodyProblems: placeholders, comments, fences, heading level and case', () => {
    const two = (b: string) => bodyProblems(b, TWO);
    const filled = (ctx: string, guide = 'Look at the gate.') => `## Context\n${ctx}\n## Reviewer guide\n${guide}\n`;
    assert.deepEqual(two(filled('Why it exists.')), []);
    assert.deepEqual(two('## context\nWhy.\n## REVIEWER GUIDE\nHere.\n'), []);
    for (const ph of ['', 'TBD', '_TBD_', 'TODO', 'todo.', 'N/A', '-', '<!-- fill in -->', '...']) {
        assert.equal(two(filled(ph)).length, 1, `placeholder ${JSON.stringify(ph)}`);
    }
    assert.deepEqual(two(filled('### Sub\nWhy it exists.')), [], 'a subheading is content');
    assert.equal(two('### Context\nWhy.\n### Reviewer guide\nHere.\n').length, 2, 'only ## headings count');
    assert.equal(two('```\n## Context\nWhy.\n## Reviewer guide\nHere.\n```\n').length, 2, 'headings in a fence do not count');
    assert.equal(two('## Context\nWhy.\n# Other\nstuff\n## Reviewer guide\nHere.\n').length, 0);
    assert.equal(two('## Context\n# Other\nstuff\n## Reviewer guide\nHere.\n').length, 1, 'a section ends at the next heading');
});

test('a repeated flag is a usage error, so the checked body is the one gh gets', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    const good = bodyFile(f.repo, GOOD_BODY);
    const bad = bodyFile(f.repo, 'nothing here\n');
    const r = open(f, ['--body-file', good, '--body-file', bad, '--dry-run']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--body-file given more than once/);
    const sneaky = open(f, ['--title', '--body-file', good, '--dry-run']);
    assert.equal(sneaky.status, 2, 'a flag name used as a value is not the body file');
    assert.ok(!existsSync(f.log));
});

const CTX = { stacked: false, codeFiles: 1 };

test('bodyProblems: sections come from the rules, and n/a with a reason fills one', () => {
    const rules = { ...NONE, sections: ['Context', 'Notes'] };
    assert.deepEqual(bodyProblems('## Context\nWhy.\n## Notes\nn/a, nothing to add\n', rules), []);
    assert.deepEqual(bodyProblems('## Context\nWhy.\n## Notes\nn/a\n', rules), ['"## Notes" has no content (empty or a placeholder)']);
    assert.deepEqual(bodyProblems('## Context\nWhy.\n', rules), ['missing a "## Notes" section']);
});

test('bodyProblems: the risk line must be well formed, and high risk needs a real rollback', () => {
    const body = (risk: string, rollback = 'Plain revert.') => `## Risk and blast radius\n${risk}\n## Rollback / flag\n${rollback}\n`;
    const risk = (b: string) => bodyProblems(b, { ...NONE, risk: true });
    assert.deepEqual(risk(body('Risk: low - internal')), []);
    assert.deepEqual(risk(body('- **Risk:** Medium, one tenant')), []);
    assert.match(risk(body('It is fine.'))[0], /no "Risk: low \| medium \| high" line/);
    assert.match(risk(body('Risk: severe'))[0], /no "Risk/);
    assert.deepEqual(risk(body('Risk: high - migration', 'Revert plus migration down.')), []);
    assert.match(risk(body('Risk: high - migration', 'n/a'))[0], /Risk is high/);
    assert.match(risk(body('Risk: high - migration', 'n/a, trust me'))[0], /Risk is high/);
    assert.match(risk('## Risk and blast radius\nRisk: high - x\n')[0], /Risk is high/, 'no rollback section at all');
    assert.deepEqual(bodyProblems(body('nonsense'), NONE), [], 'switched off');
});

test('bodyProblems: the verify section needs a filled code fence unless it is n/a with a reason', () => {
    const v = (text: string) => bodyProblems(`## How to verify locally\n${text}\n`, { ...NONE, verify: true });
    assert.deepEqual(v('```bash\nnpm test\n```'), []);
    assert.deepEqual(v('~~~\nrun it\n~~~'), []);
    assert.deepEqual(v('n/a, docs only, no runtime change'), []);
    assert.equal(v('run npm test').length, 1);
    assert.equal(v('```\n```').length, 1, 'an empty fence is not a command');
    assert.equal(v('n/a').length, 1);
    assert.deepEqual(bodyProblems('## Context\nx\n', { ...NONE, verify: true }), [], 'no verify section: the sections rule decides, not this one');
});

test('bodyProblems: attribution, key, token and PHI-shaped content is refused without echoing it', () => {
    const cases: [string, RegExp][] = [
        ['Co-Authored-By: Someone <a@example.com>', /AI attribution/],
        ['Generated with [Claude Code](x)', /AI attribution/],
        [['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''), /private key/],
        [['AKI', 'AABCDEFGHIJKLMNOP'].join(''), /AWS access key/],
        [`ghp_${'a'.repeat(36)}`, /GitHub token/],
        [['api_', 'key = "abcdefghij0123456789"'].join(''), /credential assignment/],
        ['ssn 123-45-6789', /SSN-shaped/],
        ['MRN: 00123456', /medical record/],
    ];
    for (const [text, expected] of cases) {
        const p = bodyProblems(`## Context\n${text}\n`, { ...NONE, forbidden: true });
        assert.equal(p.length, 1, expected.source);
        assert.match(p[0], expected);
        assert.ok(!p[0].includes(text.slice(-12)), 'the match itself is never printed');
    }
    assert.deepEqual(bodyProblems('## Context\nThe token store holds sessions.\n', { ...NONE, forbidden: true }), []);
    assert.deepEqual(bodyProblems('## Context\nCo-Authored-By: x\n', NONE), [], 'switched off');
});

test('bodyProblems: a stacked or wide PR needs a mermaid diagram or a Diagram: n/a line', () => {
    const d = (text: string, ctx: { stacked: boolean; codeFiles: number }) => bodyProblems(`## Context\n${text}\n`, { ...NONE, diagram: true }, ctx);
    assert.deepEqual(d('plain', CTX), [], 'small, not stacked: advisory only');
    assert.match(d('plain', { stacked: true, codeFiles: 1 })[0], /stacked PR needs a mermaid diagram/);
    assert.match(d('plain', { stacked: false, codeFiles: 4 })[0], /over 3 code files/);
    assert.deepEqual(d('```mermaid\nflowchart LR\n  A --> B\n```', { stacked: true, codeFiles: 9 }), []);
    assert.deepEqual(d('Diagram: n/a, one-line config change', { stacked: true, codeFiles: 1 }), []);
    assert.equal(d('Diagram: n/a', { stacked: true, codeFiles: 1 }).length, 1, 'n/a needs a reason');
    assert.deepEqual(bodyProblems('## Context\nx\n', { ...NONE, diagram: true, diagramMinFiles: 9 }, { stacked: false, codeFiles: 8 }), []);
});

test('pr-open runs the structural rules end to end: a stacked base needs a diagram, a bad risk line refuses', () => {
    const f = fixture({ 'src/a.py': lines(3) });
    git(f.repo, 'branch', 'feature-base', 'main');
    const stacked = spawnSync(process.execPath, [SCRIPT, '--repo', f.repo, '--base', 'feature-base', '--title', 'T', '--body-file', bodyFile(f.repo, GOOD_BODY), '--dry-run'], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.repo, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH_BIN: f.gh },
    });
    assert.equal(stacked.status, 1);
    assert.match(stacked.stderr, /stacked PR needs a mermaid diagram/);
    const noRisk = open(f, ['--body-file', bodyFile(f.repo, GOOD_BODY.replace('Risk: low', 'Fine'))]);
    assert.equal(noRisk.status, 1);
    assert.match(noRisk.stderr, /no "Risk: low \| medium \| high" line/);
    assert.ok(!existsSync(f.log));
});
