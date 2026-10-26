/**
 * List the warning clusters that appear in one session but not the other.
 *
 * Comparing clusters rather than log lines is what makes "what did the newly added mods break"
 * answerable: the shared backlog of warnings is filtered out and only the new shapes remain.
 *
 * Usage: node new-warnings.mjs <current.log> <previous.log>
 */

import fs from 'node:fs';

import { analyze } from '../lib/report.js';

const [current, previous] = process.argv.slice(2);
if (!current || !previous) {
  console.error('usage: node new-warnings.mjs <current.log> <previous.log>');
  process.exit(2);
}

/** Cluster one file on its own, without touching the incremental cursor. */
function clustersOf(file) {
  const stat = fs.statSync(file);
  const env = {
    sources: { realtime: { path: file, exists: true, bytes: stat.size, mtime: stat.mtimeMs } },
  };
  return analyze(env, { sources: ['realtime'], full: true, maxClusters: 100, persist: false });
}

const now = clustersOf(current);
const before = clustersOf(previous);

/** A stable identity for a cluster, independent of numbers and counts. */
const keyOf = (c) => `${c.level}|${c.normalized}`;

const beforeKeys = new Set(before.clusters.map(keyOf));
const afterKeys = new Set(now.clusters.map(keyOf));

const brandNew = now.clusters.filter((c) => !beforeKeys.has(keyOf(c)));
const gone = before.clusters.filter((c) => !afterKeys.has(keyOf(c)));

console.log(`current : ${now.problemClusters} error / ${now.warningClusters} warning clusters`);
console.log(`previous: ${before.problemClusters} error / ${before.warningClusters} warning clusters`);

console.log(`\n=== 只在本次出现（${brandNew.length}）—— 新加 mod 最可能的产物 ===`);
for (const c of brandNew.sort((a, b) => b.occurrences - a.occurrences)) {
  console.log(`\n  [${c.level}] ×${c.occurrences}  ${String(c.samples?.[0] ?? c.normalized).slice(0, 120)}`);
  if (c.firstTime) console.log(`      时间: ${c.firstTime}`);
  if (c.attributedMod) {
    console.log(`      归属: ${c.attributedMod.name} [${c.attributedMod.packageId ?? '?'}]  (${c.attributedMod.confidence ?? '?'})`);
  } else {
    console.log('      归属: 未能确定');
  }
  const frame = (c.frames ?? []).find((f) => f.file && !f.file.startsWith('<'));
  if (frame) console.log(`      路径线索: ${String(frame.file).slice(0, 110)}`);
}

console.log(`\n\n=== 只在上一轮出现（${gone.length}）—— 已消失 ===`);
for (const c of gone.sort((a, b) => b.occurrences - a.occurrences).slice(0, 20)) {
  console.log(`  [${c.level}] ×${c.occurrences}  ${String(c.samples?.[0] ?? c.normalized).slice(0, 100)}`);
}
