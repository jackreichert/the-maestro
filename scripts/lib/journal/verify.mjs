import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Integrity problems in the raw ledger file: unparseable lines, duplicate ids, references to ids that do not exist. */
export function verifyLedger(ctx) {
    const { ledgerPath, approvals: APPROVALS, approvableKinds: APPROVABLE_KINDS } = ctx;
    const problems = [];
    const text = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '';
    const rows = [];
    text.split('\n').forEach((l, n) => {
        if (!l.trim()) return;
        try {
            const row = JSON.parse(l);
            if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('not an object');
            rows.push({ row, line: n + 1 });
        } catch {
            problems.push({ line: n + 1, problem: 'line does not parse as a JSON object' });
        }
    });
    const seen = new Map();
    for (const { row, line } of rows) {
        if (row.id === undefined) continue;
        if (seen.has(row.id)) problems.push({ line, id: row.id, problem: `duplicate id (first on line ${seen.get(row.id)})` });
        else seen.set(row.id, line);
    }
    const missing = (line, row, field, id) => { if (id && !seen.has(id)) problems.push({ line, id: row.id, problem: `${field} refers to ${id}, which does not exist` }); };
    for (const { row, line } of rows) {
        if (row.approval !== undefined && !APPROVALS.has(row.approval)) problems.push({ line, id: row.id, problem: `approval "${row.approval}" is not one of: ${[...APPROVALS].join(', ')}` });
        if (row.kind === 'approval-tag' && !APPROVALS.has(row.approval)) problems.push({ line, id: row.id, problem: 'approval-tag row has no valid approval' });
        const target = row.kind === 'approval-tag' && row.approves ? rows.find((r) => r.row.id === row.approves)?.row : undefined;
        if (target && !APPROVABLE_KINDS.has(target.kind)) problems.push({ line, id: row.id, problem: `approves ${row.approves}, a ${target.kind} row; only ${[...APPROVABLE_KINDS].join(', ')} can be approved` });
        for (const field of ['closes', 'carries', 'tags', 'annotates', 'approves', 'defers']) missing(line, row, field, row[field]);
        if (row.kind === 'archive') for (const id of row.ids || []) missing(line, row, 'archive ids', id);
    }
    problems.sort((a, b) => a.line - b.line);
    return { rows: rows.length, problems };
}

/**
 * The optional backup after a roll: only when ledger_git_autocommit is on and the ledger root is itself a
 * git repo. Runs verify first and refuses to commit a ledger that fails it. Stages explicit paths
 * (`git add -- <path>...`), never -A, and commits just those paths. Returns false when it should have
 * committed and could not.
 */
export function autoCommitLedger(ctx, d) {
    const { autocommit: LEDGER_GIT_AUTOCOMMIT, dryRun, vault } = ctx;
    if (!LEDGER_GIT_AUTOCOMMIT || dryRun) return true;
    const git = (...a) => spawnSync('git', ['-C', vault, ...a], { encoding: 'utf8' });
    const top = git('rev-parse', '--show-toplevel');
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(vault)) {
        console.error(`ledger_git_autocommit is on but ${vault} is not a git repository root; not committing.`);
        return true;
    }
    const { problems } = verifyLedger(ctx);
    if (problems.length) {
        console.error(`Not committing: verify found ${problems.length} problem(s). Run \`journal.mjs verify\`.`);
        return false;
    }
    const st = git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all');
    if (st.status !== 0) { console.error(`git status failed: ${st.stderr.trim()}`); return false; }
    const paths = st.stdout.split('\0').filter(Boolean).map((e) => e.slice(3));
    if (!paths.length) { console.log('ledger git: nothing to commit.'); return true; }
    const add = git('add', '--', ...paths);
    if (add.status !== 0) { console.error(`git add failed: ${add.stderr.trim()}`); return false; }
    const commit = git('commit', '-m', `chore(ledger): roll ${d}`, '--', ...paths);
    if (commit.status !== 0) { console.error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`); return false; }
    console.log(`ledger git: committed ${paths.length} path(s) as "chore(ledger): roll ${d}".`);
    return true;
}
