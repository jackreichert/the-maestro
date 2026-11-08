import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
  appendLine, canonical, hash, readJson, readText, requireValue, scopedPath,
  withLock, writeJson, atomicWrite, ensureDirectory, keys,
} from './storage.mjs';
import {envelopeHash, identifier, prepareEnvelope, validateEnvelope} from './schema.mjs';

function logFiles(root) {
  const directory = scopedPath(root, 'Events');
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory).sort().filter((name) => name.endsWith('.jsonl'));
  requireValue(files.every((name) => /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/.test(name)), 'Unexpected journal filename; reconcile without reading unknown files');
  return files;
}

export function readJournal(root) {
  const rows = [];
  const checkpointIds = new Set();
  const eventIds = new Set();
  const pageIds = new Set();
  for (const name of logFiles(root)) {
    const text = readText(root, `Events/${name}`);
    requireValue(text === '' || text.endsWith('\n'), 'Incomplete journal append; preserve file and reconcile manually');
    for (const line of text.split('\n').slice(0, -1)) {
      let row;
      try { row = JSON.parse(line); } catch { throw new Error('Corrupt journal row; no records skipped'); }
      keys(row, ['seq', 'payload_hash', 'payload'], ['seq', 'payload_hash', 'payload']);
      requireValue(row && Number.isInteger(row.seq) && row.seq > 0 && typeof row.payload_hash === 'string', 'Invalid journal envelope');
      validateEnvelope(row.payload);
      requireValue(row.payload_hash === envelopeHash(row.payload), 'Journal hash mismatch');
      requireValue(!checkpointIds.has(row.payload.id), 'Duplicate checkpoint in journal');
      checkpointIds.add(row.payload.id);
      for (const event of row.payload.events) {
        requireValue(!eventIds.has(event.id), 'Duplicate event in journal');
        eventIds.add(event.id);
      }
      for (const page of row.payload.pages) {
        requireValue(!pageIds.has(page.id), 'Duplicate page operation in journal');
        pageIds.add(page.id);
      }
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.seq - b.seq);
  rows.forEach((row, index) => requireValue(row.seq === index + 1, 'Journal sequence gap or collision'));
  const earlier = [];
  for (const row of rows) {
    validateReferences(earlier, row.payload);
    earlier.push(row);
  }
  return rows;
}

function validateReferences(rows, payload) {
  const topics = new Map(rows.flatMap((row) => row.payload.topics).map((topic) => [topic.id, topic]));
  const events = new Map(rows.flatMap((row) => row.payload.events).map((event) => [event.id, event]));
  const operations = new Map(rows.flatMap((row) => row.payload.pages).map((page) => [page.id, page]));
  const committedOperations = new Set(operations.keys());
  for (const topic of payload.topics) topics.set(topic.id, topic);
  for (const event of payload.events) {
    requireValue(topics.has(event.topic_id) && !events.has(event.id), 'Unknown topic or existing event ID');
    for (const key of ['resolves', 'supersedes', 'replaces']) {
      for (const id of event[key] ?? []) {
        const target = events.get(id);
        requireValue(target && target.topic_id === event.topic_id, 'Relationship requires an earlier event in the same topic');
        if (key === 'resolves') {
          requireValue(['question', 'blocker'].includes(target.kind), 'Only questions or blockers may be resolved');
          requireValue(target.kind !== 'question' || event.kind === 'decision', 'Question resolution requires a decision');
          requireValue(![...events.values()].some((other) => other.resolves?.includes(id)), 'Already resolved; reconcile conflicting answer');
        }
      }
    }
    events.set(event.id, event);
  }
  for (const page of payload.pages) {
    requireValue(!operations.has(page.id), 'Existing page operation ID');
    if (page.supersedes) {
      const previous = operations.get(page.supersedes);
      requireValue(previous && committedOperations.has(page.supersedes) && previous.path === page.path && previous.surface === page.surface
        && ![...operations.values()].some((operation) => operation.supersedes === page.supersedes),
      'Superseded operation must be an unreplaced earlier patch of the same page');
    }
    operations.set(page.id, page);
    for (const id of page.resolves ?? []) {
      requireValue(events.get(id)?.kind === 'question'
        && [...events.values()].some((event) => event.kind === 'decision' && event.resolves?.includes(id)),
      'Question removal requires a durable decision');
    }
  }
}

export function prepare(context, input) {
  const payload = prepareEnvelope(input);
  return withLock(context.ledger, () => {
    for (const page of payload.pages) scopedPath(context.vault, page.path);
    const relative = `Pending/${payload.session_id}/${payload.id}.json`;
    const existing = readJson(context.ledger, relative);
    if (existing) {
      requireValue(envelopeHash(existing) === envelopeHash(payload), 'Checkpoint ID reused with different payload');
      return existing;
    }
    const rows = readJournal(context.ledger);
    const committed = rows.find((row) => row.payload.id === payload.id);
    if (committed) requireValue(committed.payload_hash === envelopeHash(payload), 'Committed checkpoint ID collision');
    else validateReferences(rows, payload);
    writeJson(context.ledger, relative, payload);
    return payload;
  });
}

const containsId = (text, id) => new RegExp(`(?:^|[^a-zA-Z0-9_-])${id}(?=$|[^a-zA-Z0-9_-])`).test(text ?? '');

function patchResult(current, page, questions) {
  requireValue((current === null ? null : hash(current)) === page.expected_sha256, 'Page revision conflict; preserve edits and reprepare');
  let text = current ?? '';
  for (const {before, after} of page.changes) {
    if (before === '') {
      requireValue(page.expected_sha256 === null && text === '', 'Empty match is allowed only for new files');
      text = after;
    } else {
      requireValue(text.split(before).length === 2, 'Patch match missing or ambiguous');
      text = text.replace(before, () => after);
    }
  }
  for (const id of page.resolves ?? []) {
    requireValue(containsId(current, id) && !containsId(text, id), 'Resolved question must be removed from patched page');
  }
  if (page.surface === 'podium') {
    for (const id of questions) {
      requireValue(!containsId(current, id) || containsId(text, id) || page.resolves?.includes(id),
        'Removing a question requires explicit resolution references');
    }
  }
  return text;
}

function applyPages(context, payload, state, saveState, fault, questions, rows) {
  for (const page of payload.pages) {
    if (state.pages[page.id]?.status === 'superseded') continue;
    try {
      if (state.pages[page.id]?.status !== 'applied') {
        const current = readText(context.vault, page.path);
        const saved = state.pages[page.id];
        if (!saved?.result_sha256 || current === null || hash(current) !== saved.result_sha256) {
          const result = patchResult(current, page, questions);
          state.pages[page.id] = {surface: page.surface, status: 'pending', result_sha256: hash(result)};
          saveState();
          fault('before-page', page);
          atomicWrite(context.vault, page.path, result);
          fault('after-page', page);
        }
        state.pages[page.id] = {...state.pages[page.id], status: 'applied'};
        delete state.pages[page.id].error;
        saveState();
      }
      if (page.supersedes) {
        const previous = rows.find((row) => row.payload.pages.some((operation) => operation.id === page.supersedes));
        requireValue(previous, 'Superseded operation not committed');
        const previousStatePath = `Pending/${previous.payload.session_id}/${previous.payload.id}.state.json`;
        const previousState = readJson(context.ledger, previousStatePath);
        requireValue(previousState?.ledger === 'applied' && previousState.payload_hash === previous.payload_hash
          && previousState.pages, 'Missing or mismatched superseded operation receipt; reconcile manually');
        if (previousState.pages[page.supersedes]?.status !== 'superseded'
          || previousState.pages[page.supersedes].replaced_by !== page.id) {
          previousState.pages[page.supersedes] = {surface: page.surface, status: 'superseded', replaced_by: page.id};
          writeJson(context.ledger, previousStatePath, previousState);
        }
      }
    } catch (error) {
      state.pages[page.id] = {...state.pages[page.id], surface: page.surface, status: 'failed', error: error.code ?? error.message};
      saveState();
    }
  }
}

function flushOne(context, relative, fault, rows) {
  const payload = validateEnvelope(readJson(context.ledger, relative));
  const statePath = relative.replace(/\.json$/, '.state.json');
  const state = readJson(context.ledger, statePath) ?? {payload_hash: envelopeHash(payload), ledger: 'pending', pages: {}, index: 'pending'};
  keys(state, ['payload_hash', 'ledger', 'pages', 'index', 'seq', 'index_error', 'question_removals', 'question_error'], ['payload_hash', 'ledger', 'pages', 'index']);
  requireValue(state.payload_hash === envelopeHash(payload), 'Receipt belongs to a different checkpoint payload');
  requireValue(['pending', 'applied'].includes(state.ledger) && ['pending', 'applied', 'failed'].includes(state.index), 'Invalid persistence receipt');
  keys(state.pages, payload.pages.map((page) => page.id));
  for (const saved of Object.values(state.pages)) {
    keys(saved, ['surface', 'status', 'result_sha256', 'error', 'replaced_by'], ['surface', 'status']);
    requireValue(['podium', 'library'].includes(saved.surface) && ['pending', 'applied', 'failed', 'superseded'].includes(saved.status)
      && (saved.result_sha256 === undefined || /^[a-f0-9]{64}$/.test(saved.result_sha256))
      && (saved.status !== 'applied' || saved.result_sha256)
      && (saved.status !== 'superseded' || identifier(saved.replaced_by)), 'Invalid page receipt');
  }
  for (const [id, saved] of Object.entries(state.pages)) {
    requireValue(saved.surface === payload.pages.find((page) => page.id === id).surface, 'Receipt surface mismatch');
    if (saved.status === 'superseded') {
      requireValue(rows.some((row) => row.payload.pages.some((page) => page.id === saved.replaced_by && page.supersedes === id)),
        'Receipt replacement is not durable');
    }
  }
  let savedState = readJson(context.ledger, statePath);
  const saveState = () => {
    if (canonical(savedState) === canonical(state)) return;
    writeJson(context.ledger, statePath, state);
    savedState = structuredClone(state);
  };
  let committed = rows.find((row) => row.payload.id === payload.id);
  if (committed) requireValue(committed.payload_hash === envelopeHash(payload), 'Checkpoint identity conflict');
  else {
    validateReferences(rows, payload);
    committed = {seq: rows.length + 1, payload_hash: envelopeHash(payload), payload};
    fault('before-append', payload);
    appendLine(context.ledger, `Events/${new Date().toISOString().slice(0, 7)}.jsonl`, committed);
    rows.push(committed);
    fault('after-append', payload);
  }
  const alreadyApplied = state.ledger === 'applied' && state.index === 'applied'
    && payload.pages.every((page) => ['applied', 'superseded'].includes(state.pages[page.id]?.status));
  state.ledger = 'applied';
  state.seq = committed.seq;
  saveState();
  const questions = rows.flatMap((row) => row.payload.events).filter((event) => event.kind === 'question').map((event) => event.id);
  applyPages(context, payload, state, saveState, fault, questions, rows);
  if (!alreadyApplied) try {
    fault('before-index', payload);
    rebuild(context, rows);
    state.index = 'applied';
    delete state.index_error;
  } catch (error) {
    state.index = 'failed';
    state.index_error = error.message;
  }
  saveState();
}

function podiumText(context) {
  const texts = [readText(context.vault, 'Podium/README.md') ?? ''];
  const streams = scopedPath(context.vault, 'Podium/Streams');
  if (fs.existsSync(streams)) {
    for (const name of fs.readdirSync(streams).filter((name) => /^[a-zA-Z0-9_-]+\.md$/.test(name))) {
      texts.push(readText(context.vault, `Podium/Streams/${name}`) ?? '');
    }
  }
  return texts.join('\n');
}

function receipt(payload, state) {
  const incompleteQuestions = Object.values(state.question_removals ?? {}).includes('failed');
  return {
    id: payload.id, seq: state.seq, ledger: state.ledger, question_removals: state.question_removals ?? {},
    podium: incompleteQuestions ? 'failed' : surfaceState(payload, state, 'podium'), library: surfaceState(payload, state, 'library'),
    index: state.index, errors: [...Object.values(state.pages).filter((page) => page.status === 'failed').map((page) => page.error),
      ...(state.index_error ? [state.index_error] : []),
      ...(incompleteQuestions ? [state.question_error ?? 'Resolved question remains on a Podium list; prepare remaining removals'] : [])],
  };
}

function surfaceState(payload, state, surface) {
  const pages = payload.pages.filter((page) => page.surface === surface);
  if (pages.length === 0) return 'not-needed';
  if (pages.every((page) => state.pages[page.id]?.status === 'superseded')) return 'superseded';
  return pages.every((page) => ['applied', 'superseded'].includes(state.pages[page.id]?.status)) ? 'applied' : 'failed';
}

export function flush(context, session, {fault = () => {}} = {}) {
  requireValue(identifier(session), 'Invalid session ID');
  return withLock(context.ledger, () => withLock(context.vault, () => {
    const directory = scopedPath(context.ledger, `Pending/${session}`);
    if (!fs.existsSync(directory)) return {session_id: session, coverage: 'no-prepared-delta', checkpoints: []};
    const pending = fs.readdirSync(directory).filter((name) => name.endsWith('.json') && !name.endsWith('.state.json'))
      .map((name) => `Pending/${session}/${name}`);
    const rows = readJournal(context.ledger);
    pending.sort((a, b) => {
      const first = readJson(context.ledger, a);
      const second = readJson(context.ledger, b);
      return first.timestamp.localeCompare(second.timestamp) || a.localeCompare(b);
    });
    for (const relative of pending) {
      const payload = validateEnvelope(readJson(context.ledger, relative));
      requireValue(payload.session_id === session && relative.endsWith(`/${payload.id}.json`), 'Pending identity/path mismatch');
      flushOne(context, relative, fault, rows);
    }
    const completed = pending.map((relative) => ({
      payload: readJson(context.ledger, relative),
      statePath: relative.replace(/\.json$/, '.state.json'),
      state: readJson(context.ledger, relative.replace(/\.json$/, '.state.json')),
    }));
    if (completed.some(({payload}) => payload.pages.some((page) => page.resolves?.length))) {
      let text;
      let error;
      try { text = podiumText(context); } catch (failure) { error = failure.code ?? failure.message; }
      for (const {payload, statePath, state} of completed) {
        const resolving = [...new Set(payload.pages.flatMap((page) => page.resolves ?? []))];
        if (!resolving.length) continue;
        const previous = canonical(state);
        state.question_removals = Object.fromEntries(resolving.map((id) => [id, error || containsId(text, id) ? 'failed' : 'applied']));
        if (error) state.question_error = error;
        else delete state.question_error;
        if (canonical(state) !== previous) writeJson(context.ledger, statePath, state);
      }
    }
    const checkpoints = completed.map(({payload, state}) => receipt(payload, state));
    return {session_id: session, coverage: pending.length ? 'prepared-only' : 'no-prepared-delta', checkpoints};
  }));
}

function fingerprint(context) {
  return hash(canonical(logFiles(context.ledger).map((name) => {
    const stat = fs.statSync(scopedPath(context.ledger, `Events/${name}`));
    return [name, stat.size, stat.mtimeMs, stat.ctimeMs];
  })));
}

function openDatabase(context) {
  const file = scopedPath(context.ledger, 'Index/ledger.sqlite');
  for (const suffix of ['-journal', '-wal', '-shm']) scopedPath(context.ledger, `Index/ledger.sqlite${suffix}`);
  ensureDirectory(context.ledger, 'Index');
  return new DatabaseSync(file);
}

export function rebuild(context, rows = readJournal(context.ledger)) {
  const db = openDatabase(context);
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      DROP TABLE IF EXISTS topics; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS search;
      CREATE TABLE topics (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX events_topic ON events(topic_id, seq);
      CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, topic_id UNINDEXED, text);`);
    const topics = new Map(rows.flatMap((row) => row.payload.topics).map((topic) => [topic.id, topic]));
    for (const topic of topics.values()) {
      db.prepare('INSERT INTO topics VALUES (?, ?)').run(topic.id, JSON.stringify(topic));
      db.prepare('INSERT INTO search VALUES (?, ?, ?)').run(topic.id, topic.id, [topic.name, ...topic.aliases, ...topic.repos, ...topic.references].join(' '));
      projectTopic(context, topic);
    }
    for (const row of rows) {
      for (const event of row.payload.events) {
        const entry = {...event, seq: row.seq, timestamp: row.payload.timestamp, session_id: row.payload.session_id, turn_id: row.payload.turn_id};
        db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)').run(event.id, event.topic_id, row.seq, JSON.stringify(entry));
        db.prepare('INSERT INTO search VALUES (?, ?, ?)').run(event.id, event.topic_id,
          [event.summary, event.details ?? '', ...event.sources].join(' '));
      }
    }
    db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run('fingerprint', fingerprint(context));
    db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run('seq', String(rows.length));
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

function projectTopic(context, topic) {
  const relative = `Topics/${topic.id}/topic.json`;
  const statePath = `Topics/${topic.id}/topic-state.json`;
  const current = readText(context.ledger, relative);
  const result = `${JSON.stringify(topic, null, 2)}\n`;
  const desired = hash(result);
  const saved = readJson(context.ledger, statePath);
  if (current === result && saved?.accepted_sha256 === desired && saved.result_sha256 === desired) return;
  requireValue(current === null || hash(current) === desired
    || (saved && [saved.accepted_sha256, saved.result_sha256].includes(hash(current))),
  'Topic metadata was edited outside journal; preserve it and reconcile explicitly');
  writeJson(context.ledger, statePath, {accepted_sha256: current === null ? null : hash(current), result_sha256: desired});
  atomicWrite(context.ledger, relative, result);
  writeJson(context.ledger, statePath, {accepted_sha256: desired, result_sha256: desired});
}

function currentDatabase(context) {
  let db = openDatabase(context);
  try {
    const hasMetadata = db.prepare("SELECT name FROM sqlite_master WHERE name = 'metadata'").get();
    const saved = hasMetadata ? db.prepare("SELECT value FROM metadata WHERE key = 'fingerprint'").get()?.value : null;
    if (saved !== fingerprint(context)) {
      db.close();
      db = null;
      rebuild(context);
      db = openDatabase(context);
    }
    return db;
  } catch (error) {
    if (db) db.close();
    throw error;
  }
}

export function search(context, term) {
  requireValue(typeof term === 'string' && term.trim().length > 0 && term.length < 500, 'Provide a bounded search phrase');
  return withLock(context.ledger, () => {
    const db = currentDatabase(context);
    try {
      const phrase = `"${term.replaceAll('"', '""')}"`;
      return db.prepare('SELECT id, topic_id, snippet(search, 2, \'<\', \'>\', \'...\', 24) AS excerpt FROM search WHERE search MATCH ? LIMIT 20').all(phrase);
    } finally { db.close(); }
  });
}

export function lookup(context, id) {
  requireValue(identifier(id), 'Invalid event ID');
  return withLock(context.ledger, () => {
    const db = currentDatabase(context);
    try {
      const record = db.prepare('SELECT json FROM events WHERE id = ?').get(id);
      requireValue(record, 'Unknown event ID');
      const event = JSON.parse(record.json);
      const related = db.prepare('SELECT json FROM events WHERE topic_id = ? ORDER BY seq, rowid').all(event.topic_id)
        .map((row) => JSON.parse(row.json))
        .filter((other) => ['resolves', 'supersedes', 'replaces'].some((key) => other[key]?.includes(id)));
      return {event, related};
    } finally { db.close(); }
  });
}

function topicData(context, id) {
  requireValue(identifier(id), 'Invalid topic ID');
  const db = currentDatabase(context);
  try {
    const topic = db.prepare('SELECT json FROM topics WHERE id = ?').get(id);
    requireValue(topic, 'Unknown topic');
    return {
      topic: JSON.parse(topic.json),
      seq: Number(db.prepare("SELECT value FROM metadata WHERE key = 'seq'").get().value),
      events: db.prepare('SELECT json FROM events WHERE topic_id = ? ORDER BY seq, rowid').all(id).map((row) => JSON.parse(row.json)),
    };
  } finally { db.close(); }
}

export function refreshBrief(context, id) {
  return withLock(context.ledger, () => {
    const data = topicData(context, id);
    const lines = data.events.map((event) => `- [${event.kind}] ${event.id}: ${event.summary}${event.details ? `\n  ${event.details}` : ''}\n  Sources: ${event.sources.join(', ') || 'none'}${['resolves', 'supersedes', 'replaces'].map((key) => event[key]?.length ? `; ${key}: ${event[key].join(', ')}` : '').join('')}`);
    const text = `---\ntopic_id: ${id}\nupdated: ${new Date().toISOString()}\ncovered_through_seq: ${data.seq}\n---\n\n# ${data.topic.name}\n\n## Evidence through sequence ${data.seq}\n\n${lines.join('\n') || 'No events.'}\n\nAll topic events through the watermark are listed, not synthesized. Relationships are explicit; unresolved contradictions remain. Read Podium for current coordination.\n`;
    const metadata = {topic_id: id, covered_through_seq: data.seq, brief_sha256: hash(text)};
    writeJson(context.ledger, `Topics/${id}/brief-state.json`, metadata);
    atomicWrite(context.ledger, `Topics/${id}/brief.md`, text);
    return metadata;
  });
}

export function recover(context, id) {
  return withLock(context.ledger, () => {
    const data = topicData(context, id);
    const brief = readText(context.ledger, `Topics/${id}/brief.md`);
    const state = readJson(context.ledger, `Topics/${id}/brief-state.json`);
    const valid = brief !== null && state?.topic_id === id && state.brief_sha256 === hash(brief)
      && Number.isInteger(state.covered_through_seq) && state.covered_through_seq >= 0 && state.covered_through_seq <= data.seq;
    const coverage = valid ? state.covered_through_seq : 0;
    return {
      topic: data.topic, snapshot_seq: data.seq, brief: valid ? brief : null,
      coverage: valid ? 'verified-brief' : 'missing-or-modified-brief',
      uncovered: data.events.filter((event) => event.seq > coverage),
    };
  });
}
