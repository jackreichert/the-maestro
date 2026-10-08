// Run: node --test scripts/pr-open.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { bodyProblems, type BodyRules } from './pr-body.ts';
import { recordSmells, smellsLine } from './pr-smells.ts';

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

const NONE: BodyRules = { sections: [], risk: false, verify: false, forbidden: false, diagram: false, diagramMinFiles: 3, private: false, privateWords: [], privatePatterns: [], voice: false, voiceNames: [], counts: false, stack: false, order: false, orderMinFiles: 3 };
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

const open = ({ repo, gh }: { repo: string; gh: string }, extra: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--title', 'T', ...(extra.includes('--body-file') || extra.includes('--no-body') ? [] : ['--body-file', bodyFile(repo, GOOD_BODY)]), ...extra.filter((a) => a !== '--no-body')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: repo, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH_BIN: gh, ...env },
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

test('bodyProblems: a stacked PR names its base PR in a Stack section, or says n/a with a reason', () => {
    const st = (text: string, ctx = { stacked: true, codeFiles: 1 }) => bodyProblems(`## Context\nx\n${text}`, { ...NONE, stack: true }, ctx);
    assert.deepEqual(st('', { stacked: false, codeFiles: 1 }), [], 'not stacked: no Stack section needed');
    assert.match(st('')[0], /stacked PR needs a "## Stack" section/);
    assert.match(st('## Stack\n_TBD_\n')[0], /"## Stack" section names no base PR/);
    assert.match(st('## Stack\nPosition: 2 of 4, standalone review: yes\n')[0], /names no base PR/);
    assert.match(st('## Stack\nPosition: 2 of 4, see ticket #123\n')[0], /names no base PR/, 'a bare number is not a base');
    assert.deepEqual(st('## Stack\nPosition: 2 of 4. Base: #12. Standalone review: yes\n'), []);
    assert.deepEqual(st('## Stack\nBase: https://github.com/o/r/pull/12\n'), []);
    assert.deepEqual(st('## Stack\nn/a, the base is a long-lived release branch\n'), []);
    assert.deepEqual(bodyProblems('## Context\nx\n', NONE, { stacked: true, codeFiles: 1 }), [], 'switched off');
});

test('bodyProblems: a PR over the file threshold gives a review order that points at files', () => {
    const rg = (text: string, ctx = { stacked: false, codeFiles: 4 }) => bodyProblems(`## Context\nx\n## Reviewer guide\n${text}\n`, { ...NONE, order: true }, ctx);
    assert.deepEqual(rg('- Validated: ran it', { stacked: false, codeFiles: 3 }), [], 'at the threshold: only over it');
    assert.match(rg('- Validated: ran it')[0], /needs a "Review order:" line in the Reviewer guide/);
    assert.match(rg('- Review order: read the core first')[0], /names no file/);
    assert.deepEqual(rg('- Review order: 1. {{file:src/core.ts}} 2. {{file:src/core.test.ts}}'), []);
    assert.deepEqual(rg('- Review order: 1. `src/core.ts` then the tests'), []);
    assert.deepEqual(rg('- Review order: n/a, the files are independent'), []);
    assert.deepEqual(rg('- Review order:\n  1. {{file:src/core.ts}}\n  2. {{file:src/b.ts}}\n- Skim-safe: none'), [], 'files nested under the label count');
    assert.match(rg('- Review order:\n- Skim-safe: {{file:src/x.ts}}')[0], /names no file/, 'a sibling bullet does not count');
    assert.match(rg('- Review order: start with the `e.g.` part and `v1.2`')[0], /names no file/, 'a backtick token must look like a path');
    assert.deepEqual(bodyProblems('## Context\nx\n', { ...NONE, order: true, orderMinFiles: 9 }, { stacked: false, codeFiles: 9 }), []);
    assert.deepEqual(bodyProblems('## Context\nx\n', NONE, { stacked: false, codeFiles: 8 }), [], 'switched off');
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

test('bodyProblems: private references are refused in the body and the title, naming the line', () => {
    const rules = { ...NONE, private: true, privateWords: ['ledger', 'vault', 'orchestrator'], privatePatterns: ['\\bX-\\d{3}\\b'] };
    const p = (text: string, title = '') => bodyProblems(`## Context\n${text}\n`, rules, { stacked: false, codeFiles: 0, title });
    assert.deepEqual(p('Fixes the retry bug in PR #12 (see abc1234).'), []);
    assert.match(p('See [[Some Note]] for more')[0], /\[\[wiki-link\]\].*line: See \[\[Some Note\]\] for more/);
    assert.match(p('open obsidian://open?vault=x')[0], /obsidian:\/\//);
    assert.match(p('logged in the ledger')[0], /private-workspace word/);
    assert.match(p('the Vault note')[0], /private-workspace word/);
    assert.match(p('tracked as X-123')[0], /private id \(/);
    assert.match(p('fine', 'fix: the orchestrator retry')[0], /the title has/);
    assert.deepEqual(bodyProblems('## Context\nthe ledger\n', NONE), [], 'switched off');
    assert.deepEqual(p('run `journal.ts --vault x` first'), [], 'a word inside inline code is fine');
    assert.deepEqual(bodyProblems('## Context\nthe ledger\n', { ...rules, privateWords: [] }), [], 'the word list can be emptied');
    assert.match(bodyProblems('## Context\n[[Note]]\n', { ...rules, privateWords: [] })[0], /wiki-link/, 'wiki-links stay refused');
});

test('bodyProblems: voice check flags the author in the third person and assistant or agent words, outside code', () => {
    const rules = { ...NONE, voice: true, voiceNames: ['Sam Fictional', 'samf'] };
    const p = (text: string) => bodyProblems(`## Context\n${text}\n`, rules);
    assert.deepEqual(p('I changed the retry cap and I would like your eyes on the backoff.'), []);
    assert.match(p('Sam Fictional decided to cap retries')[0], /not in the author's own voice/);
    assert.match(p('needs samf to look')[0], /own voice/);
    assert.match(p('the assistant wrote this')[0], /own voice/);
    assert.deepEqual(p('Sets the User-Agent header and fixes the ssh-agent socket path'), [], 'ordinary uses of the words are fine');
    assert.match(p('an AI-generated change')[0], /own voice/);
    assert.deepEqual(p('run `agent --help` first'), [], 'inline code is skipped');
    assert.deepEqual(p('```\nagent run\n```'), [], 'fenced code is skipped for voice');
    assert.deepEqual(bodyProblems('## Context\nthe agent\n', NONE), [], 'switched off');
});

test('bodyProblems: counts the PR page already shows are refused outside code; a code span is the escape', () => {
    const rules = { ...NONE, counts: true };
    const p = (text: string) => bodyProblems(`## Context\n${text}\n`, rules);
    for (const stale of ['This is 3 commits.', 'The 13 commits + lint fixes', 'touches 12 files changed', '1 file', 'about 40 lines', 'diff is +120 -40', 'diff is +120 \u221240', 'Two commits: 2 commits']) assert.match(p(stale)[0], /count the PR page already shows/, stale);
    assert.match(p('3 commits')[0], /line: 3 commits/);
    assert.deepEqual(p('The first commit adds the parser; the second wires it into `pr-open.ts`.'), []);
    assert.deepEqual(p('Ran `npm test` on 4f04517: all pass.'), [], 'what was run and against which commit is fine');
    assert.deepEqual(p('Review order 1. a.ts 2. b.ts; position 2 of 4; ran 5 tests'), [], 'list numbers, stack position and test counts are not the counted nouns');
    assert.deepEqual(p('the limit is `2 files` per call'), [], 'a number in a code span is the escape');
    assert.deepEqual(bodyProblems('## Context\n```\n3 commits +1 -2\n```\n', rules), [], 'fenced code is skipped');
    assert.match(bodyProblems('## Context\nfine\n', rules, { stacked: false, codeFiles: 0, title: 'fix: 3 files' })[0], /the title states a count/);
    assert.deepEqual(bodyProblems('## Context\n3 commits\n', NONE), [], 'switched off');
});

test('bodyProblems: an unedited template, and a diagram that only sits in an HTML comment, do not pass', () => {
    const template = [
        '## Context', '<why this change exists, 2-4 lines>', '## Reviewer guide', '- Review order: 1. a.ts',
        '## Risk and blast radius', 'Risk: low | medium | high - <one-line reason>',
        '## Rollback / flag', 'Plain revert.', '## How to verify locally', '```bash', '<exact command>', '```', '',
    ].join('\n');
    const rules = { ...NONE, sections: ['Context', 'Reviewer guide', 'Risk and blast radius', 'Rollback / flag', 'How to verify locally'], risk: true, verify: true };
    const p = bodyProblems(template, rules);
    assert.ok(p.some((x) => /"## Context" has no content/.test(x)), p.join('; '));
    assert.ok(p.some((x) => /no "Risk: low/.test(x)));
    assert.ok(p.some((x) => /verify section has no fenced/.test(x)));
    const stacked = { stacked: true, codeFiles: 1 };
    const hidden = bodyProblems('## Context\nx\n<!--\n```mermaid\nflowchart LR\n```\n-->\n', { ...NONE, diagram: true }, stacked);
    assert.equal(hidden.length, 1, 'a commented-out diagram is not a diagram');
});

const GATED = { MAESTRO_PR_SMELLS_REPOS: 'example/*' };
const withOrigin = (f: { repo: string }): void => git(f.repo, 'remote', 'add', 'origin', 'https://github.com/example/widgets.git');

test('smells gate: a gated repo with no recorded run refuses and never calls gh, even on a dry run', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    withOrigin(f);
    for (const extra of [[], ['--dry-run']]) {
        const r = open(f, [...extra, '--head', 'feature'], GATED);
        assert.equal(r.status, 1, extra.join(' '));
        assert.match(r.stderr, /none is recorded/);
    }
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('smells gate: a recorded run must also be on its own line in the body, then the PR opens', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    withOrigin(f);
    const rec = recordSmells(f.repo, 'no findings worth fixing', 'feature');
    const missing = open(f, ['--head', 'feature'], GATED);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Smells: no findings worth fixing/);
    assert.ok(!existsSync(f.log));
    const body = bodyFile(f.repo, `${GOOD_BODY}\n${smellsLine(rec)}\n`);
    const ok = open(f, ['--body-file', body, '--head', 'feature'], GATED);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(f.log, 'utf8'), /pr create --draft --assignee @me/);
});

test('smells gate: a commit after the recorded run invalidates it', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    withOrigin(f);
    const rec = recordSmells(f.repo, 'clean', 'feature');
    put(f.repo, 'src/b.py', lines(2));
    git(f.repo, 'add', '--all');
    git(f.repo, 'commit', '-q', '-m', 'more');
    const r = open(f, ['--body-file', bodyFile(f.repo, `${GOOD_BODY}\n${smellsLine(rec)}\n`), '--head', 'feature'], GATED);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /none is recorded/);
});

test('smells gate: off by default, outside the listed repos, and for a diff with no code', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    withOrigin(f);
    assert.equal(open(f, ['--dry-run', '--head', 'feature']).status, 0, 'default off');
    assert.equal(open(f, ['--dry-run', '--head', 'feature'], { MAESTRO_PR_SMELLS_REPOS: 'other/*' }).status, 0, 'repo not listed');
    const docs = fixture({ 'docs/a.md': lines(10) });
    withOrigin(docs);
    assert.equal(open(docs, ['--dry-run', '--head', 'feature'], GATED).status, 0, 'docs only');
});

const WAIVED = { MAESTRO_WAIVE_SIZE_GATE_OWNERS: 'example-owner' };
const originAt = (f: { repo: string }, slug: string): void => git(f.repo, 'remote', 'add', 'origin', `https://github.com/${slug}.git`);

test('size waiver: a repo under a waived owner passes the real gate with a visible note, and gh gets draft and assignee', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    originAt(f, 'example-owner/widgets');
    const r = open(f, ['--head', 'feature'], WAIVED);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /verdict:\s+FAIL/, 'the gate still measured the diff');
    assert.match(r.stdout, /size limits waived for example-owner\/widgets \(waive_size_gate_owners\)/);
    assert.match(readFileSync(f.log, 'utf8'), /pr create --draft --assignee @me/);
});

test('size waiver: it lifts the size limits only, so code mixed with a lockfile still refuses', () => {
    const f = fixture({ 'src/big.py': lines(500), 'uv.lock': lines(50) });
    originAt(f, 'example-owner/widgets');
    const r = open(f, ['--head', 'feature'], WAIVED);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mixes code with mechanical files/);
    assert.ok(!existsSync(f.log), 'gh must not run');
    const small = fixture({ 'src/a.py': lines(3), 'uv.lock': lines(50) });
    originAt(small, 'example-owner/widgets');
    assert.equal(open(small, ['--head', 'feature'], WAIVED).status, 1, 'mixed refuses even when within budget');
});

test('size waiver: an unlisted owner still refuses even when another owner is waived', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    originAt(f, 'other-org/widgets');
    const r = open(f, ['--head', 'feature'], WAIVED);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /split plan/);
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('size waiver: off by default, and no origin or a non-GitHub origin fails closed', () => {
    const none = fixture({ 'src/big.py': lines(500) });
    originAt(none, 'example-owner/widgets');
    assert.equal(open(none, ['--head', 'feature']).status, 1, 'no setting');
    const bare = fixture({ 'src/big.py': lines(500) });
    assert.equal(open(bare, ['--head', 'feature'], WAIVED).status, 1, 'no origin');
    const other = fixture({ 'src/big.py': lines(500) });
    git(other.repo, 'remote', 'add', 'origin', 'https://git.example.com/example-owner/widgets.git');
    assert.equal(open(other, ['--head', 'feature'], WAIVED).status, 1, 'not GitHub');
    assert.ok(![none, bare, other].some((f) => existsSync(f.log)), 'gh must not run');
});

test('size waiver: there is no flag to ask for it, and the other checks still apply', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    originAt(f, 'example-owner/widgets');
    assert.equal(open(f, ['--head', 'feature', '--waive-size-gate'], WAIVED).status, 2);
    assert.equal(open(f, ['--no-body', '--head', 'feature'], WAIVED).status, 1, 'body still required');
    assert.ok(!existsSync(f.log));
});

test('size waiver: owner matching is case-insensitive and owner/name globs narrow it', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    originAt(f, 'Example-Owner/widgets');
    assert.equal(open(f, ['--dry-run', '--head', 'feature'], { MAESTRO_WAIVE_SIZE_GATE_OWNERS: 'example-owner/gad*' }).status, 1, 'glob does not match');
    assert.equal(open(f, ['--dry-run', '--head', 'feature'], { MAESTRO_WAIVE_SIZE_GATE_OWNERS: 'example-owner/wid*' }).status, 0);
});

test('private words: the default list refuses ledger but lets the public product word Podium through the real CLI', () => {
    const f = fixture({ 'src/a.py': lines(10) });
    const podium = open(f, ['--dry-run', '--head', 'feature', '--body-file', bodyFile(f.repo, GOOD_BODY.replace('Why this exists', 'Adds a Podium tab. Why this exists'))]);
    assert.equal(podium.status, 0, podium.stderr);
    const ledger = open(f, ['--dry-run', '--head', 'feature', '--body-file', bodyFile(f.repo, GOOD_BODY.replace('Why this exists', 'Logged in the ledger. Why this exists'))]);
    assert.equal(ledger.status, 1);
    assert.match(ledger.stderr, /private-workspace word/);
    const custom = open(f, ['--dry-run', '--head', 'feature', '--body-file', bodyFile(f.repo, GOOD_BODY.replace('Why this exists', 'Adds a Podium tab. Why this exists'))], { MAESTRO_PR_BODY_PRIVATE_WORDS: 'Podium' });
    assert.equal(custom.status, 1, 'an install can still list it');
});

test('size waiver: gh is pinned to the checked origin repo, and a spoofed origin url is not waived', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    originAt(f, 'example-owner/widgets');
    git(f.repo, 'remote', 'add', 'upstream', 'https://github.com/other-org/widgets.git');
    const r = open(f, ['--head', 'feature'], { ...WAIVED, GH_REPO: 'other-org/widgets' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(f.log, 'utf8'), /--repo example-owner\/widgets/);
    for (const url of ['https://notgithub.com/example-owner/x', 'https://evil.example/github.com/example-owner/x', 'https://github.com/other-org/x?github.com/example-owner/y']) {
        const s = fixture({ 'src/big.py': lines(500) });
        git(s.repo, 'remote', 'add', 'origin', url);
        assert.equal(open(s, ['--head', 'feature'], WAIVED).status, 1, url);
        assert.ok(!existsSync(s.log), url);
    }
});

test('size waiver: an owner wildcard in the setting is ignored, so it cannot waive everything', () => {
    const f = fixture({ 'src/big.py': lines(500) });
    originAt(f, 'other-org/widgets');
    assert.equal(open(f, ['--head', 'feature'], { MAESTRO_WAIVE_SIZE_GATE_OWNERS: '*, */*' }).status, 1);
});
