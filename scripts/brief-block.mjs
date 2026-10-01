#!/usr/bin/env node
/**
 * BRIEF BLOCK: prints the standing brief block from reference/brief.md with its `<…>` slots
 * filled (two from the configured values, `<maestro scripts dir>` from this script's location), ready to paste at the end of a dispatch brief.
 *
 * The values sit under "Standing brief block, filled" in the user config file or the org overlay's
 * config.md (see reference/local-config.md), one bullet per slot:  - `<slot>` → value
 * Exits 1, printing nothing to stdout, if a slot has no value or any other `<…>` is left in the text.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userPath, overlayPath } from './local-config.mjs';

export const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
export const SLOTS = ['<user git emails>', '<tracker key example>', '<maestro scripts dir>'];
/** Angle-bracket text that is part of the block's own wording, not a slot. */
const LITERALS = new Set(['<base>', '<check>']);

/** The standing block: the first ```text fence under its heading in brief.md. */
export function extractBlock(markdown) {
  const after = markdown.split(/^### Standing brief block.*$/m)[1] || '';
  return (after.match(/^```text\n([\s\S]*?)^```/m) || [])[1] || '';
}

/** Reads { '<slot>': value } from the "Standing brief block, filled" section of a config file. */
export function parseSlotValues(markdown) {
  const section = (markdown.split(/^#+ Standing brief block, filled.*$/m)[1] || '').split(/^#+ /m)[0];
  const out = {};
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s+`(<[^`>]+>)`\s*(?:→|->)\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^`(.*)`$/, '$1');
  }
  return out;
}

/** Fills the slots; returns { text, problems }. A slot is problematic if unset or still `<…>` afterwards.
 *  `<maestro scripts dir>` is not configured: it is this script's own directory, so workers get a runnable path. */
export function fillBlock(block, values) {
  values = { '<maestro scripts dir>': SCRIPTS_DIR, ...values };
  let text = block;
  for (const slot of SLOTS) if (values[slot]) text = text.split(slot).join(values[slot]);
  const left = (text.match(/<[^<>\n]+>/g) || []).filter((t) => !LITERALS.has(t));
  return { text, problems: [...new Set(left)] };
}

function main() {
  const briefPath = fileURLToPath(new URL('../reference/brief.md', import.meta.url));
  const block = extractBlock(readFileSync(briefPath, 'utf8'));
  if (!block) { console.error('brief-block: standing block not found in reference/brief.md'); process.exit(1); }
  const values = {};
  // Overlay first, then the user file, so the user file wins, as everywhere else in local-config.
  for (const file of [overlayPath, userPath]) {
    if (file && existsSync(file)) Object.assign(values, parseSlotValues(readFileSync(file, 'utf8')));
  }
  const { text, problems } = fillBlock(block, values);
  if (problems.length) {
    console.error(`brief-block: unfilled ${problems.join(', ')}. Set them under "Standing brief block, filled" (reference/local-config.md).`);
    process.exit(1);
  }
  process.stdout.write(text);
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
