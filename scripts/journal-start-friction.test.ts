// Run: node --test scripts/journal-start-friction.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correctedCommand, inferStreamForRepo, modelOfAgentType } from './lib/journal/start-hints.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
let vault: string;
let home: string;

function run(args: string[]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd: home,
        env: { ...process.env, HOME: home, VAULT_ROOT: '', MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_WINDOW: 'w1' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const rows = (): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'start-friction-'));
    home = mkdtempSync(join(tmpdir(), 'start-friction-home-'));
    mkdirSync(join(vault, 'Projects', 'test-proj'), { recursive: true });
    writeFileSync(join(vault, 'Projects', 'test-proj', 'streams.json'), JSON.stringify({ streams: { Maestro: { aliases: ['maestro'], status: 'active' }, Podium: { aliases: [], status: 'active' } } }));
});

test('correctedCommand swaps a flag value, adds a missing one and quotes what needs it', () => {
    assert.equal(correctedCommand(['start', 'do a thing', '--stream', 'podium'], { stream: 'Podium' }), "journal.ts start 'do a thing' --stream Podium");
    assert.equal(correctedCommand(['start', 'x'], { model: '<MODEL>' }), 'journal.ts start x --model <MODEL>');
    assert.equal(correctedCommand(['start', 'x', '--stream=podium'], { stream: 'Podium' }), 'journal.ts start x --stream Podium');
});

test('inferStreamForRepo answers only when the repo has used exactly one stream', () => {
    const canon = (s: string) => (s === 'maestro' ? 'Maestro' : s);
    const item = (repo: string, stream: string) => ({ repo, stream }) as never;
    assert.equal(inferStreamForRepo([item('r', 'Maestro'), item('r', 'maestro')], 'r', canon), 'Maestro');
    assert.equal(inferStreamForRepo([item('r', 'Maestro'), item('r', 'Podium')], 'r', canon), undefined);
    assert.equal(inferStreamForRepo([item('other', 'Podium')], 'r', canon), undefined);
    assert.equal(inferStreamForRepo([item('r', 'Maestro')], undefined, canon), undefined);
});

test('modelOfAgentType reads the model line of the definition and refuses paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-'));
    writeFileSync(join(dir, 'worker.md'), '---\nname: worker\nmodel: sonnet\n---\nbody\nmodel: nope\n');
    writeFileSync(join(dir, 'inheritor.md'), '---\nname: inheritor\nmodel: inherit\n---\n');
    assert.equal(modelOfAgentType('worker', [dir]), 'sonnet');
    assert.equal(modelOfAgentType('inheritor', [dir]), undefined);
    assert.equal(modelOfAgentType('../worker', [dir]), undefined);
    assert.equal(modelOfAgentType('plugin:worker', [dir]), undefined, 'a plugin-qualified name is not read as the bare one');
    assert.equal(modelOfAgentType('missing', [dir]), undefined);
});

test('start infers the stream from the repo when the ledger names one, and says so', () => {
    assert.equal(run(['start', 'first', '--repo', 'r1', '--stream', 'Maestro', ...MARK]).code, 0);
    const r = run(['start', 'second', '--repo', 'r1', ...MARK]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /stream Maestro \(inferred from repo r1/);
    assert.equal(rows().filter((x) => x.text === 'second')[0]?.stream, 'Maestro');
});

test('start does not guess when the repo has used two streams', () => {
    run(['start', 'a', '--repo', 'r2', '--stream', 'Maestro', ...MARK]);
    run(['start', 'b', '--repo', 'r2', '--stream', 'Podium', ...MARK]);
    const r = run(['start', 'c', '--repo', 'r2', ...MARK]);
    assert.equal(r.code, 0);
    assert.equal(rows().filter((x) => x.text === 'c')[0]?.stream, undefined);
});

test('an unknown stream refuses with the corrected command', () => {
    const r = run(['start', 'x', '--stream', 'podum', ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Run: journal\.ts start x --stream Podium /);
    assert.match(r.err, /--new-stream/);
});

test('missing --model/--used refuses with a command that cannot run until it is filled in', () => {
    const r = run(['start', 'x', '--stream', 'Maestro']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Run: journal\.ts start x --stream Maestro .*--model <MODEL> --used <SKILLS_AND_TOOLS>\n/);
    assert.match(r.err, /Replace <MODEL> and <SKILLS_AND_TOOLS> with real values first/);
    const line = (/^Run: (.*)$/m.exec(r.err) as RegExpExecArray)[1] as string;
    assert.equal(spawnSync('sh', ['-n', '-c', line]).status, 2, 'the printed line is a shell syntax error until the markers are replaced');
});

test('a fill-in marker is refused as a model or a mark, never recorded', () => {
    const r = run(['start', 'x', '--model', '<MODEL>', '--used', 'skill:a']);
    assert.equal(r.code, 1);
    assert.match(r.err, /must be real values/);
    assert.equal(run(['start', 'x', '--model', 'Test Model', '--used', '<SKILLS_AND_TOOLS>']).code, 1);
});

test('start does not infer a stream that is archived or no longer registered, and queue never infers', () => {
    run(['start', 'a', '--repo', 'r3', '--stream', 'Maestro', ...MARK]);
    run(['start', 'g', '--repo', 'r4', '--stream', 'Podium', ...MARK]);
    writeFileSync(join(vault, 'Projects', 'test-proj', 'streams.json'), JSON.stringify({ streams: { Maestro: { aliases: [], status: 'archived' }, Other: { aliases: [], status: 'active' } } }));
    const archived = run(['start', 'b', '--repo', 'r3', ...MARK]);
    assert.equal(archived.code, 0, archived.err);
    const gone = run(['start', 'h', '--repo', 'r4', ...MARK]);
    assert.equal(gone.code, 0, gone.err);
    assert.equal(rows().filter((x) => x.text === 'b' || x.text === 'h').every((x) => x.stream === undefined), true);
});

test('queue and log --kind wip do not infer a stream', () => {
    run(['start', 'a', '--repo', 'r5', '--stream', 'Maestro', ...MARK]);
    assert.equal(run(['queue', 'later', '--repo', 'r5', ...MARK]).code, 0);
    assert.equal(rows().find((x) => x.text === 'later')?.stream, undefined);
});

test('an unknown stream with no near match still prints a Run: line, and --agent-type names itself when it finds no model', () => {
    const r = run(['start', 'x', '--stream', 'zzzzzz', ...MARK]);
    assert.equal(r.code, 1);
    assert.match(r.err, /register it as a new stream, run: journal\.ts start x --stream zzzzzz .*--new-stream/);
    const m = run(['start', 'x', '--agent-type', 'ghost', '--used', 'tool:Agent']);
    assert.equal(m.code, 1);
    assert.match(m.err, /--agent-type ghost named no model/);
});

test('--agent-type supplies --model from the agent definition', () => {
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(home, '.claude', 'agents', 'repo-worker.md'), '---\nname: repo-worker\nmodel: claude-opus-5-5\n---\n');
    const r = run(['start', 'x', '--agent-type', 'repo-worker', '--used', 'tool:Agent']);
    assert.equal(r.code, 0, r.err);
    assert.equal(rows().find((x) => x.text === 'x')?.model, 'claude-opus-5-5');
});

test('a fill-in marker is refused in every mark flag, and an empty HOME never makes the agent lookup read the working directory', () => {
    for (const flag of ['--tokens', '--harness', '--agent']) for (const v of ['<NAME>', '<...>']) assert.equal(run(['start', 'x', flag, v, ...MARK]).code, 1, `${flag} ${v}`);
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(home, '.claude', 'agents', 'evil.md'), '---\nmodel: claude-opus-5-5\n---\n');
    const r = spawnSync(process.execPath, [SCRIPT, 'start', 'y', '--agent-type', 'evil', '--used', 'tool:Agent', '--vault', vault, '--project', 'test-proj'], { encoding: 'utf8', cwd: home, env: { ...process.env, HOME: '', VAULT_ROOT: '', MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_WINDOW: 'w1' } });
    assert.equal(r.status, 1, 'the definition under cwd/.claude/agents is not read');
});

test('a plugin-qualified --agent-type is told to pass the bare name', () => {
    const r = run(['start', 'x', '--agent-type', 'anduril:worker', '--used', 'tool:Agent']);
    assert.equal(r.code, 1);
    assert.match(r.err, /pass the bare agent name/);
});
