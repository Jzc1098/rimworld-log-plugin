/** Focused check for the plain-text Player.log parser against the real file. Dev aid. */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parsePlayerLog } from './lib/playerlog.js';
import { normalizeText } from './lib/parse.js';

const root = path.join(os.homedir(), 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios');
for (const name of ['Player.log', 'Player-prev.log']) {
  const file = path.join(root, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    console.log(`${name}: not readable`);
    continue;
  }
  const entries = parsePlayerLog(text);
  const byLevel = {};
  for (const entry of entries) byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
  const withFrames = entries.filter((e) => e.frames.length > 0).length;
  const withDetails = entries.filter((e) => e.details.length > 0).length;
  console.log(`\n=== ${name} ===`);
  console.log(`  bytes=${Buffer.byteLength(text, 'utf8')} lines=${text.split('\n').length} entries=${entries.length}`);
  console.log(`  levels=${JSON.stringify(byLevel)} withFrames=${withFrames} withDetails=${withDetails}`);
  console.log('  -- first 6 error entries --');
  const errors = entries.filter((e) => e.level === 'ERROR');
  console.log(`  total ERROR entries: ${errors.length}`);
  for (const entry of errors.slice(0, 6)) {
    console.log(`   · ${entry.message.split('\n')[0].slice(0, 150)}`);
    console.log(`     type=${entry.inferredType || '-'} frames=${entry.frames.length}`);
  }
  // How well would these collapse into clusters?
  const groups = new Map();
  for (const entry of errors) {
    const key = normalizeText(entry.message);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log(`  distinct normalized ERROR messages: ${groups.size} (from ${errors.length} entries)`);
}
