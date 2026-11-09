import {execFileSync} from 'node:child_process';
import {hash, requireValue} from '../storage.mjs';

export function observePR(watch, execute) {
  const deadline = Date.now() + 30000;
  const run = args => {
    const remaining = deadline - Date.now();
    requireValue(remaining > 0, 'PR observation exceeded 30 seconds');
    return execute ? execute(args) : JSON.parse(execFileSync('gh', args, {
      encoding: 'utf8', timeout: Math.min(15000, remaining), maxBuffer: 8 * 1024 * 1024,
    }));
  };
  const [owner, name] = watch.repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
    repository(owner:$owner,name:$name) { pullRequest(number:$number) {
      state url mergeable headRefOid
      reviewThreads(first:100,after:$cursor) { pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first:100) {
          nodes { id updatedAt url } pageInfo { hasNextPage endCursor } } } }
    } }
  }`;
  let cursor;
  let pr;
  const threads = [];
  const cursors = new Set();
  do {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-F', `number=${watch.number}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])];
    const response = run(args);
    requireValue(!response.errors, 'GitHub GraphQL errors');
    const page = response.data?.repository?.pullRequest;
    requireValue(page && Array.isArray(page.reviewThreads?.nodes), 'Incomplete PR thread response');
    if (pr) requireValue(pr.headRefOid === page.headRefOid, 'PR changed during pagination; retry');
    pr = page;
    threads.push(...page.reviewThreads.nodes);
    const info = page.reviewThreads.pageInfo;
    requireValue(info && typeof info.hasNextPage === 'boolean', 'Missing thread pagination');
    cursor = info.hasNextPage ? info.endCursor : null;
    if (cursor) {
      requireValue(typeof cursor === 'string' && !cursors.has(cursor) && cursors.size < 100, 'Invalid/bounded thread pagination');
      cursors.add(cursor);
    } else requireValue(!info.hasNextPage, 'Missing next cursor');
  } while (cursor);
  requireValue(['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
    && typeof pr.url === 'string' && typeof pr.headRefOid === 'string', 'Incomplete PR state');
  if (pr.state !== 'OPEN') return {closed: true, items: []};
  requireValue(['MERGEABLE', 'CONFLICTING'].includes(pr.mergeable), 'PR mergeability is unknown');
  const items = [];
  for (const thread of threads) {
    requireValue(typeof thread.isResolved === 'boolean' && typeof thread.id === 'string'
      && Array.isArray(thread.comments?.nodes) && thread.comments.pageInfo, 'Incomplete thread identity');
    const comments = [...thread.comments.nodes];
    let page = thread.comments;
    requireValue(typeof page.pageInfo.hasNextPage === 'boolean', 'Missing reply pagination');
    const seen = new Set();
    while (page.pageInfo.hasNextPage) {
      const after = page.pageInfo.endCursor;
      requireValue(typeof after === 'string' && !seen.has(after) && seen.size < 100, 'Invalid reply pagination');
      seen.add(after);
      const replies = run(['api', 'graphql', '-f', `query=query($id:ID!,$cursor:String!) {
        node(id:$id) { ... on PullRequestReviewThread {
          comments(first:100,after:$cursor) { nodes { id updatedAt url } pageInfo { hasNextPage endCursor } }
        } }
      }`, '-f', `id=${thread.id}`, '-f', `cursor=${after}`]);
      requireValue(!replies.errors && Array.isArray(replies.data?.node?.comments?.nodes)
        && replies.data.node.comments.pageInfo, 'Incomplete replies');
      page = replies.data.node.comments;
      requireValue(typeof page.pageInfo.hasNextPage === 'boolean', 'Missing reply pagination');
      comments.push(...page.nodes);
    }
    requireValue(comments.every(c => c.id && c.updatedAt && c.url), 'Missing comment identity');
    if (!thread.isResolved) {
      requireValue(comments.length, 'Empty unresolved thread');
      items.push({key: `thread:${thread.id}:${hash(JSON.stringify(comments)).slice(0, 16)}`,
        type: 'pr-feedback', url: comments.at(-1).url});
    }
  }
  if (pr.mergeable === 'CONFLICTING') items.push({key: 'conflict', type: 'pr-conflict', url: pr.url});
  for (const [endpoint, key] of [['issues/' + watch.number + '/comments', 'comment'],
    ['pulls/' + watch.number + '/reviews', 'review']]) {
    const pages = run(['api', '--paginate', '--slurp', `repos/${watch.repo}/${endpoint}?per_page=100`]);
    requireValue(Array.isArray(pages) && pages.every(Array.isArray), 'Incomplete feedback pagination');
    for (const comment of pages.flat()) {
      if (key === 'review' && !comment.body && comment.state !== 'CHANGES_REQUESTED') continue;
      requireValue(Number.isSafeInteger(comment.id) && typeof comment.html_url === 'string', 'Invalid feedback response');
      items.push({key: `${key}:${comment.id}:${comment.updated_at ?? comment.submitted_at ?? ''}`,
        type: 'pr-feedback', url: comment.html_url});
    }
  }
  const checks = run(['api', '--paginate', '--slurp',
    `repos/${watch.repo}/commits/${pr.headRefOid}/check-runs?per_page=100`]);
  requireValue(Array.isArray(checks) && checks.every(page => Array.isArray(page.check_runs)), 'Incomplete check pagination');
  for (const check of checks.flatMap(page => page.check_runs)) {
    if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(check.conclusion)) {
      items.push({key: `check:${check.id}:${check.conclusion}`, type: 'pr-check-failed', url: check.html_url});
    }
  }
  const statuses = run(['api', '--paginate', '--slurp',
    `repos/${watch.repo}/commits/${pr.headRefOid}/statuses?per_page=100`]);
  requireValue(Array.isArray(statuses) && statuses.every(Array.isArray), 'Incomplete status pagination');
  const contexts = new Set();
  for (const status of statuses.flat()) {
    if (contexts.has(status.context)) continue;
    contexts.add(status.context);
    if (['failure', 'error'].includes(status.state)) items.push({
      key: `status:${status.id}:${status.state}`, type: 'pr-check-failed', url: status.target_url ?? pr.url,
    });
  }
  return {closed: false, items: items.sort((a, b) => a.key.localeCompare(b.key))};
}
