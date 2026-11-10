import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {eventReferences} from '../scripts/references.mjs';
import {flush, lookup, prepare, readJournal, rebuild, recover, refreshBrief, search} from '../scripts/ledger.mjs';
import {envelopeHash} from '../scripts/schema.mjs';
import {hash, withLock} from '../scripts/storage.mjs';
import {fixture, memoryCli} from './helpers.mjs';

const request = (session = 'window-one') => ({
  session_id: session, turn_id: 'turn-one',
  topics: [{id: 'short-refs', name: 'Short references', aliases: [], repos: [], references: []}],
  events: [{topic_id: 'short-refs', kind: 'question', summary: 'Synthetic question?', sources: []}],
});

test('four-character references persist across retries, index rebuild, CLI lookup, search and recovery', t => {
  const f = fixture(t);
  const prepared = prepare(f, request());
  const event = prepared.events[0];
  assert.match(event.id, /^[\da-f-]{36}$/);
  assert.match(event.short_ref, /^[a-zA-Z0-9]{4}$/);
  assert.deepEqual(prepare(f, prepared), prepared);
  const withoutRef = structuredClone(prepared);
  delete withoutRef.events[0].short_ref;
  assert.deepEqual(prepare(f, withoutRef), prepared);
  const pending = prepare(f, request('window-two'));
  assert.notEqual(pending.events[0].short_ref, event.short_ref);
  flush(f, 'window-one');
  const answer = prepare(f, {...request(), turn_id: 'turn-answer', events: [{
    topic_id: event.topic_id, kind: 'decision', summary: 'Synthetic decision.', sources: [], resolves: [event.id],
  }]});
  flush(f, 'window-one');
  const cli = memoryCli(f, 'lookup', [event.short_ref]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).event.id, event.id);
  assert.equal(JSON.parse(cli.stdout).related[0].id, answer.events[0].id);
  assert.equal(lookup(f, event.id).event.short_ref, event.short_ref);
  assert.equal(search(f, 'Synthetic question')[0].short_ref, event.short_ref);
  refreshBrief(f, event.topic_id);
  assert.ok(recover(f, event.topic_id).brief.includes(`${event.short_ref} (${event.id})`));
  const journalPath = path.join(f.ledger, 'Events', readJournal(f.ledger)[0].payload.timestamp.slice(0, 7) + '.jsonl');
  const journal = fs.readFileSync(journalPath);
  withLock(f.ledger, () => rebuild(f));
  assert.equal(lookup(f, event.short_ref).event.id, event.id);
  assert.deepEqual(fs.readFileSync(journalPath), journal);
  assert.throws(() => prepare(f, {...request(), events: [{...request().events[0], id: event.short_ref}]}),
    /reserved short reference/);
});

test('allocation retries collisions, reserves canonical IDs and fails closed on corruption/exhaustion', t => {
  const f = fixture(t);
  withLock(f.ledger, () => {
    const candidates = ['Kd8h', 'Kd8h', 'AB12', 'Zz99'];
    const refs = eventReferences(f.ledger, [{id: 'first'}, {id: 'second'}, {id: 'AB12'}], () => candidates.shift());
    assert.equal(refs.get('first'), 'Kd8h');
    assert.equal(refs.get('second'), 'Zz99');
    assert.equal(refs.get('AB12'), 'AB12');
    assert.throws(() => eventReferences(f.ledger, [{id: 'third'}], () => 'Kd8h'), /exhausted/);
    assert.throws(() => eventReferences(f.ledger, [{id: 'third', short_ref: 'Kd8h'}]), /collision/);
    assert.throws(() => eventReferences(f.ledger, [{id: 'first', short_ref: 'New1'}]), /changed/);
    assert.equal(eventReferences(f.ledger, []).size, 3);
    fs.writeFileSync(path.join(f.ledger, 'event-references.json'), '{"version":1,"entries":[{"id":"one","ref":"Bad!"}]}');
    assert.throws(() => eventReferences(f.ledger, []), /Invalid/);
  });
});

test('legacy journal/index gains stable references without rewriting old envelopes or four-character IDs', t => {
  const f = fixture(t);
  const payload = {...request(), version: 1, id: 'legacy-checkpoint', timestamp: new Date().toISOString(), pages: [],
    events: [{...request().events[0], id: 'legacy-event'}, {...request().events[0], id: 'Kd8h'}]};
  fs.mkdirSync(path.join(f.ledger, 'Events'));
  const journal = path.join(f.ledger, 'Events', payload.timestamp.slice(0, 7) + '.jsonl');
  fs.writeFileSync(journal, JSON.stringify({seq: 1, payload_hash: envelopeHash(payload), payload}) + '\n');
  const before = fs.readFileSync(journal);
  const initial = lookup(f, 'legacy-event').event.short_ref;
  assert.equal(lookup(f, 'Kd8h').event.id, 'Kd8h');
  const db = new DatabaseSync(path.join(f.ledger, 'Index/ledger.sqlite'));
  db.exec("UPDATE events SET json=json_remove(json, '$.short_ref'); DELETE FROM metadata WHERE key='short_references'");
  db.close();
  assert.equal(lookup(f, initial).event.id, 'legacy-event');
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(readJournal(f.ledger)[0].payload.events[0].short_ref, undefined);
});

test('legacy pending IDs are reserved before allocation and malformed or ambiguous state is explicit', t => {
  const f = fixture(t);
  const legacy = {...request('legacy-window'), version: 1, id: 'legacy-pending', timestamp: new Date().toISOString(), pages: [],
    events: [{...request().events[0], id: 'Kd8h'}]};
  fs.mkdirSync(path.join(f.ledger, 'Pending/legacy-window'), {recursive: true});
  const pending = path.join(f.ledger, 'Pending/legacy-window/legacy-pending.json');
  fs.writeFileSync(pending, JSON.stringify(legacy));
  withLock(f.ledger, () => {
    const candidates = ['Kd8h', 'New1'];
    const refs = eventReferences(f.ledger, [{id: 'new-event'}], () => candidates.shift());
    assert.equal(refs.get('new-event'), 'New1');
    assert.equal(refs.get('Kd8h'), 'Kd8h');
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(pending)), legacy);
  flush(f, 'legacy-window');
  assert.equal(lookup(f, 'Kd8h').event.id, 'Kd8h');
  const next = prepare(f, request());
  flush(f, 'window-one');
  const db = new DatabaseSync(path.join(f.ledger, 'Index/ledger.sqlite'));
  db.prepare("UPDATE events SET json=json_set(json, '$.short_ref', ?) WHERE id=?")
    .run('Kd8h', next.events[0].id);
  db.close();
  assert.throws(() => lookup(f, 'Kd8h'), /Ambiguous event reference/);
  withLock(f.ledger, () => rebuild(f));
  fs.unlinkSync(path.join(f.ledger, 'event-references.json'));
  assert.throws(() => lookup(f, 'Kd8h'), /reservations missing/);
  assert.throws(() => prepare(f, request('new-window')), /reservations missing/);
  assert.throws(() => withLock(f.ledger, () => rebuild(f)), /reservations missing/);
});

test('short question labels retain resolve-before-removal and overflow guards using full IDs', t => {
  const f = fixture(t);
  const q = prepare(f, request()).events[0];
  flush(f, 'window-one');
  fs.mkdirSync(path.join(f.vault, 'Podium/Streams'), {recursive: true});
  const text = `${q.short_ref}: Synthetic question?\n`;
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), text);
  fs.writeFileSync(path.join(f.vault, 'Podium/Streams/sample.md'), text);
  prepare(f, {...request(), events: [], pages: [{
    id: 'illegal-removal', surface: 'podium', path: 'Podium/README.md', expected_sha256: hash(text),
    changes: [{before: text, after: 'No questions\n'}],
  }]});
  assert.equal(flush(f, 'window-one').checkpoints.at(-1).podium, 'failed');
  assert.equal(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8'), text);
  prepare(f, {...request(), events: [{topic_id: q.topic_id, kind: 'decision', summary: 'Answered.', sources: [], resolves: [q.id]}],
    pages: [{id: 'landing-removal', supersedes: 'illegal-removal', surface: 'podium', path: 'Podium/README.md',
      expected_sha256: hash(text), changes: [{before: text, after: 'No questions\n'}], resolves: [q.id]}]});
  assert.equal(flush(f, 'window-one').checkpoints.some(receipt => receipt.errors.length), true);
  prepare(f, {...request(), events: [], pages: [{
    id: 'overflow-removal', surface: 'podium', path: 'Podium/Streams/sample.md', expected_sha256: hash(text),
    changes: [{before: text, after: 'No questions\n'}], resolves: [q.id],
  }]});
  assert.ok(flush(f, 'window-one').checkpoints.every(receipt => receipt.errors.length === 0));
});
