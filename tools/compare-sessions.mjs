/**
 * Diff the mod lists of two RimCrow realtime logs, and the problem clusters in each.
 *
 * RimCrow writes the active mod list near the start of every session, so two logs give the mod
 * delta between two launches directly - no need to reason about which ids look unfamiliar.
 *
 * Usage: node compare-sessions.mjs <current.log> <previous.log>
 */

import fs from 'node:fs';

import { readLogEntriesFrom, analyze } from '../lib/report.js';

const [current, previous] = process.argv.slice(2);
if (!current || !previous) {
  console.error('usage: node compare-sessions.mjs <current.log> <previous.log>');
  process.exit(2);
}

/** Pull the session's mod list out of its log entries. */
function modIdsIn(file) {
  const read = readLogEntriesFrom(file, 0);
  const ids = new Set();
  for (const entry of read.entries) {
    const msg = String(entry.message ?? '');
    // RimCrow logs the load order as a single informational line, comma separated.
    if (/mods? (loaded|active)|active mods|加载|load order/i.test(msg)) {
      for (const part of msg.split(/[,;、]/)) {
        const id = part.trim();
        if (/^[A-Za-z0-9_.-]{4,}$/.test(id)) ids.add(id);
      }
    }
    for (const id of entry.relatedModIds ?? []) ids.add(id);
  }
  return { ids, entries: read.entries };
}

/**
 * Recover the package ids from a session.
 *
 * The load order is not always a single tidy line, so this also reads any `packageId`-shaped token
 * out of every message and keeps the ones that look like real ids. It is deliberately permissive and
 * reports how many it found, so an empty answer is visible rather than silently wrong.
 */
function modIdsLoose(file) {
  const read = readLogEntriesFrom(file, 0);
  const ids = new Set();
  for (const entry of read.entries) {
    const msg = String(entry.message ?? '');
    for (const m of msg.matchAll(/\b([a-z0-9]+(?:[._][A-Za-z0-9]+){1,4})\b/g)) {
      const id = m[1];
      if (id.length >= 6 && /[._]/.test(id)) ids.add(id.toLowerCase());
    }
  }
  return { ids, entries: read.entries.length };
}

const a = modIdsLoose(current);
const b = modIdsLoose(previous);
console.log(`current  ${current}`);
console.log(`  entries=${a.entries}  ids=${a.ids.size}`);
console.log(`previous ${previous}`);
console.log(`  entries=${b.entries}  ids=${b.ids.size}`);

const added = [...a.ids].filter((id) => !b.ids.has(id)).sort();
const removed = [...b.ids].filter((id) => !a.ids.has(id)).sort();
console.log(`\n=== id-shaped tokens only in current (${added.length}) ===`);
for (const id of added) console.log(`  + ${id}`);
console.log(`\n=== id-shaped tokens only in previous (${removed.length}) ===`);
for (const id of removed) console.log(`  - ${id}`);

// Cluster comparison, which is the part that answers "what broke".
const opts = { sources: ['realtime'], full: true, maxClusters: 40, persist: false };
for (const [label, file] of [['CURRENT', current], ['PREVIOUS', previous]]) {
  const stat = fs.statSync(file);
  const env = { sources: { realtime: { path: file, exists: true, bytes: stat.size, mtime: stat.mtimeMs } } };
  const analysis = analyze(env, opts);
  console.log(`\n${'='.repeat(80)}\n${label}: ${analysis.problemClusters} error / ${analysis.warningClusters} warning clusters`);
  console.log('='.repeat(80));
  for (const c of analysis.clusters.filter((x) => x.level === 'ERROR')) {
    console.log(`  [ERROR] x${c.occurrences}  ${String(c.samples?.[0] ?? c.normalized).slice(0, 90)}`);
    if (c.attributedMod) console.log(`          归属: ${c.attributedMod.name}`);
  }
}
