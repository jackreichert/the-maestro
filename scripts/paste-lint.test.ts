// Run: node --test scripts/paste-lint.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES, lintBlock, lintText } from './lib/paste-lint.ts';

const ids = (block: string) => lintBlock(block).map((f) => f.rule);
const SCRIPT = new URL('./paste-lint.ts', import.meta.url).pathname;

test('every rule has an id, a message and a fix hint', () => {
  for (const r of RULES) assert.ok(r.id && r.message && r.fix, r.id);
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
});

test('psql-uri-dbname: the URI plus -d block is rejected, the URI-with-path and the -h form pass', () => {
  assert.deepEqual(ids('psql "postgres://user@localhost:5432/postgres" -d app_db -c "select 1"'), ['psql-uri-dbname']);
  assert.deepEqual(ids('psql "$PRODUCTION_DB_URL" -d app_db -c "select 1"'), ['psql-uri-dbname']);
  assert.deepEqual(ids('psql postgresql://u@h/db --dbname=other'), ['psql-uri-dbname']);
  assert.deepEqual(ids('psql "postgres://user@localhost:5432/app_db" -c "select 1"'), []);
  assert.deepEqual(ids('psql -h localhost -U user -d app_db -c "select 1"'), []);
  assert.deepEqual(ids('psql -d "postgres://user@localhost/app_db"'), []);
  assert.deepEqual(ids('echo "psql $DB_URL -d x"'), []);
  assert.deepEqual(ids(`psql -h localhost -d scraper -c "select 1 where url like 'https://%'"`), []);
  assert.deepEqual(ids('psql -d scraper -v base=https://example.com -f q.sql'), []);
});

test('inline-comment: a trailing # is rejected, # in quotes, $#, a leading comment and a heredoc body pass', () => {
  assert.deepEqual(ids('N=$(date)  # note'), ['inline-comment']);
  assert.deepEqual(ids('echo "a # b" \'c # d\' ${#X} $#'), []);
  assert.deepEqual(ids('# a whole-line note\necho hi'), []);
  assert.deepEqual(ids('cat <<EOF\nkeep # this\nEOF\necho hi'), []);
  assert.deepEqual(ids('ls \\\n  -l # tail'), ['inline-comment']);
});

test('string-command-var: M="uv run" then $M is rejected, a function and a plain string var pass', () => {
  assert.deepEqual(ids('M="uv run python x.py"\n$M --flag'), ['string-command-var']);
  assert.deepEqual(ids('M="uv run x"\ncd d && ${M} a'), ['string-command-var']);
  assert.deepEqual(ids('M() { uv run python x.py "$@"; }\nM --flag'), []);
  assert.deepEqual(ids('MSG="uv run is slow"\necho "$MSG"'), []);
  assert.deepEqual(ids('M="uv run x"\n${=M} a'), []);
});

test('modifier-needs-braces: "$X:r" is rejected, "${X:r}" and a port pass', () => {
  assert.deepEqual(ids('echo "$FILE:r.bak"'), ['modifier-needs-braces']);
  assert.deepEqual(ids('echo "${FILE:r}.bak"'), []);
  assert.deepEqual(ids('curl http://$HOST:8080/x'), []);
  assert.deepEqual(ids("echo '$FILE:r'"), []);
});

test('bare-node-ts: node on a .ts file is rejected, the absolute node, a .js file and prose pass', () => {
  assert.deepEqual(ids('node scripts/journal.ts status'), ['bare-node-ts']);
  assert.deepEqual(ids('cd x && node --no-warnings scripts/a.ts'), ['bare-node-ts']);
  assert.deepEqual(ids('/opt/homebrew/bin/node scripts/journal.ts status'), []);
  assert.deepEqual(ids('node build.js'), []);
  assert.deepEqual(ids('echo "run node a.ts"'), []);
});

test('github-merge-approve: gh pr merge/approve/review --approve are rejected, a view passes', () => {
  assert.deepEqual(ids('gh pr merge 12 --squash'), ['github-merge-approve']);
  assert.deepEqual(ids('cd r && gh pr review 12 --approve'), ['github-merge-approve']);
  assert.deepEqual(ids('gh pr approve 12'), ['github-merge-approve']);
  assert.deepEqual(ids('gh pr view 12 --json state'), []);
  assert.deepEqual(ids('gh pr review 12 --comment -b "ok"'), []);
  assert.deepEqual(ids('echo "gh pr merge 12"'), []);
});

test('an arithmetic shift is not a heredoc, so later lines are still checked', () => {
  assert.deepEqual(ids('echo $(( 1 << 2 ))\ngh pr merge 3'), ['github-merge-approve']);
});

test('findings carry the source line, the text, a message and a fix', () => {
  const [f] = lintBlock('echo ok\ngh pr merge 3');
  assert.equal(f!.line, 2);
  assert.equal(f!.text, 'gh pr merge 3');
  assert.ok(f!.message && f!.fix);
});

test('lintText reads only shell fences of a markdown file and the whole text of an unfenced block', () => {
  const md = 'intro\n```bash\necho ok\ngh pr merge 3\n```\n```json\n{"a": "node x.ts"}\n```\n```zsh\nnode a.ts\n```\n';
  assert.deepEqual(lintText(md).map((f) => [f.rule, f.line]), [['github-merge-approve', 4], ['bare-node-ts', 10]]);
  assert.deepEqual(lintText('echo hi\nnode a.ts').map((f) => f.rule), ['bare-node-ts']);
  assert.deepEqual(lintText('```bash\necho clean\n```\n'), []);
});

test('the CLI exits 1 with findings, 0 when clean, 2 on bad usage, and reads stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paste-lint-'));
  const bad = join(dir, 'bad.sh');
  writeFileSync(bad, 'psql "postgres://u@h:5432/postgres" -d other\n');
  const r = spawnSync('node', [SCRIPT, bad], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /psql-uri-dbname/);
  assert.match(r.stderr, /fix:/);
  const ok = spawnSync('node', [SCRIPT], { input: '/opt/homebrew/bin/node a.ts\n', encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(spawnSync('node', [SCRIPT, 'a', 'b'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [SCRIPT, join(dir, 'missing')], { encoding: 'utf8' }).status, 2);
});
