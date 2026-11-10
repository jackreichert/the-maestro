import crypto from 'node:crypto';
import {canonical, hash, keys, requireValue} from './storage.mjs';

export const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const kinds = ['progress', 'decision', 'finding', 'blocker', 'question', 'next', 'correction', 'checkpoint'];
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function safeContent(value) {
  const text = canonical(value);
  requireValue(Buffer.byteLength(text) <= 262144, 'Checkpoint exceeds 256 KiB limit');
  const forbidden = [
    /(?:^|[\s"/\\])\.env[^/\\\s"]*/i, /ssm-[^"\s]*\.json/i,
    /-----BEGIN [^-]*PRIVATE KEY-----/, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:ghp_|github_pat_|sk_live_|xox[baprs]-)[A-Za-z0-9_-]+/,
    /(?:password|secret|api[_-]?key|access[_-]?token)\s*["']?\s*[:=]\s*["']?[^"\s,}]{4,}/i,
    /\b\d{3}-\d{2}-\d{4}\b/, /(?:MRN|DOB|SSN)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9/-]+/i,
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    /https?:\/\/[^/\s"]+:[^/\s"]+@/, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  ];
  requireValue(!forbidden.some((pattern) => pattern.test(text)), 'Potential secret, prohibited file, or personal data; redact input');
}

export function validateEnvelope(input) {
  keys(input, ['version', 'id', 'session_id', 'turn_id', 'timestamp', 'topics', 'events', 'pages'],
    ['version', 'id', 'session_id', 'turn_id', 'timestamp', 'topics', 'events', 'pages']);
  requireValue(input.version === 1 && [input.id, input.session_id, input.turn_id].every(identifier)
    && timestamp(input.timestamp), 'Invalid checkpoint identity or timestamp');
  requireValue(Array.isArray(input.topics) && Array.isArray(input.events) && Array.isArray(input.pages), 'Expected checkpoint arrays');
  for (const topic of input.topics) {
    keys(topic, ['id', 'name', 'aliases', 'repos', 'references'], ['id', 'name', 'aliases', 'repos', 'references']);
    requireValue(identifier(topic.id) && typeof topic.name === 'string' && topic.name.length > 0
      && [topic.aliases, topic.repos, topic.references].every(strings), 'Invalid topic');
  }
  for (const event of input.events) {
    keys(event, ['id', 'short_ref', 'topic_id', 'kind', 'summary', 'sources', 'details', 'resolves', 'supersedes', 'replaces'],
      ['id', 'topic_id', 'kind', 'summary', 'sources']);
    requireValue(identifier(event.id) && identifier(event.topic_id) && kinds.includes(event.kind)
      && typeof event.summary === 'string' && event.summary.length > 0 && strings(event.sources), 'Invalid event');
    requireValue(event.details === undefined || typeof event.details === 'string', 'Invalid event details');
    requireValue(event.short_ref === undefined || (typeof event.short_ref === 'string'
      && /^[a-zA-Z0-9]{4}$/.test(event.short_ref)), 'Invalid short event reference');
    for (const key of ['resolves', 'supersedes', 'replaces']) {
      requireValue(event[key] === undefined || (strings(event[key]) && event[key].every(identifier)), 'Invalid event relationship');
    }
  }
  for (const page of input.pages) {
    keys(page, ['id', 'surface', 'path', 'expected_sha256', 'changes', 'verified', 'resolves', 'supersedes'],
      ['id', 'surface', 'path', 'expected_sha256', 'changes']);
    requireValue(identifier(page.id) && ['podium', 'library'].includes(page.surface)
      && typeof page.path === 'string' && (page.expected_sha256 === null || digest(page.expected_sha256)), 'Invalid page operation');
    const allowed = page.surface === 'podium'
      ? /^(?:Podium\/README\.md|Podium\/Streams\/[a-zA-Z0-9_-]+\.md)$/
      : /^Projects\/[a-zA-Z0-9_-]+\/(?:Knowledge|Runbooks)\/[a-zA-Z0-9_/-]+\.md$/;
    requireValue(allowed.test(page.path), 'Page outside allowed surface');
    requireValue(page.surface !== 'library' || page.verified === true, 'Library patch requires verified knowledge');
    requireValue(Array.isArray(page.changes) && page.changes.length > 0, 'Empty page patch');
    for (const change of page.changes) {
      keys(change, ['before', 'after'], ['before', 'after']);
      requireValue(typeof change.before === 'string' && typeof change.after === 'string'
        && change.before !== change.after, 'Invalid patch');
    }
    requireValue(page.resolves === undefined || (page.surface === 'podium' && strings(page.resolves)
      && page.resolves.every(identifier)), 'Invalid question removal references');
    requireValue(page.supersedes === undefined || identifier(page.supersedes), 'Invalid superseded operation ID');
  }
  for (const array of [input.topics, input.events, input.pages]) {
    requireValue(new Set(array.map((item) => item.id)).size === array.length, 'Duplicate ID in checkpoint');
  }
  safeContent(input);
  return input;
}

export function prepareEnvelope(input) {
  keys(input, ['version', 'id', 'session_id', 'turn_id', 'timestamp', 'topics', 'events', 'pages'],
    ['session_id', 'turn_id']);
  const envelope = {
    version: 1, id: input.id ?? crypto.randomUUID(), session_id: input.session_id,
    turn_id: input.turn_id, timestamp: input.timestamp ?? new Date().toISOString(),
    topics: input.topics ?? [], events: (input.events ?? []).map((event) => ({...event, id: event.id ?? crypto.randomUUID()})),
    pages: (input.pages ?? []).map((page) => ({...page, id: page.id ?? crypto.randomUUID()})),
  };
  requireValue(input.version === undefined || input.version === 1, 'Unsupported input version');
  return validateEnvelope(envelope);
}

export const envelopeHash = (envelope) => hash(canonical(envelope));
