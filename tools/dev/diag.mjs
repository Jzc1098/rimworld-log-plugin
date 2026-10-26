/**
 * Diagnostic dump for the rimworld-log pipeline: what was detected, what was parsed and how
 * clusters are attributed. Development aid; not part of the plugin's runtime path.
 *
 * Usage: node diag.mjs [--brief] [--sources realtime,player]
 */

import fs from 'node:fs';

import { SOURCE_META } from './lib/parse.js';
import { detectEnvironment, activeModList } from './lib/detect.js';
import { analyze } from './lib/report.js';

const argv = process.argv.slice(2);
const wantBrief = argv.includes('--brief');
const sourceArg = argv.find((a) => a.startsWith('--sources'));
const sourceList = sourceArg
  ? (sourceArg.includes('=') ? sourceArg.split('=')[1] : argv[argv.indexOf(sourceArg) + 1]).split(',')
  : undefined;

const env = detectEnvironment();
console.log(`home: ${env.home}`);
if (env.profile) console.log(`profile: ${env.profile.name} (${env.profile.id})`);
const mods = env.profile ? activeModList(env.profile, env.config) : undefined;
if (mods) {
  console.log(`active mods: ${mods.activeCount}, missing: ${mods.missingCount}, on disk: ${mods.onDiskCount}`);
  console.log(`roots: ${mods.searchRoots.join(' | ')}`);
  console.log(`modRoots in table: ${mods.modRoots.length}`);
  console.log('\n-- first 8 modRoots --');
  for (const root of mods.modRoots.slice(0, 8)) {
    console.log(`  [${root.packageId}] ${root.name}\n      ${root.root}`);
  }
  const staging = mods.modRoots.filter((r) => /\\\.[^\\]+\\/.test(r.root));
  console.log(`\nmodRoots containing a hidden segment: ${staging.length}`);
  for (const root of staging.slice(0, 5)) console.log(`  ${root.root}`);
  env.activeMods = mods.active;
  env.modSummary = mods;
  env.modRoots = mods.modRoots;
}

if (!env.profile) process.exit(0);
const kinds = (sourceList ?? Object.entries(env.sources ?? {}).filter(([, f]) => f.exists).map(([k]) => k))
  .filter((k) => SOURCE_META[k]);
console.log(`\nsources analysed: ${kinds.join(', ')}`);

const analysis = analyze(env, {
  sources: kinds,
  full: true,
  maxClusters: 20,
  persist: false,
  modRoots: env.modRoots,
  activeMods: env.activeMods,
  indexes: env.modSummary
    ? { byAssembly: env.modSummary.byAssembly, byFolder: env.modSummary.byFolder }
    : {},
});
console.log(`\ntotals: errors=${analysis.totals.errors} warnings=${analysis.totals.warnings} infos=${analysis.totals.infos}`);
console.log(`clusters: problems=${analysis.problemClusters} warnings=${analysis.warningClusters}`);
console.log(`modTally: ${analysis.modTally.map(([id, n]) => `${id}×${n}`).join('; ') || '(empty)'}`);

let withFrames = 0;
let withFiles = 0;
let attributed = 0;
for (const cluster of analysis.clusters) {
  if (cluster.frames.length > 0) withFrames += 1;
  if (cluster.frames.some((f) => f.file)) withFiles += 1;
  if (cluster.attributedMod) attributed += 1;
}
console.log(`\nof ${analysis.clusters.length} shown clusters: ${withFrames} have frames, ${withFiles} have file paths, ${attributed} attributed to a mod`);
console.log('\n-- clusters --');
for (const [i, cluster] of analysis.clusters.entries()) {
  const where = cluster.attributedMod ? ` -> ${cluster.attributedMod.name} [${cluster.attributedMod.packageId}]` : '';
  const frame0 = cluster.frames.find((f) => f.file);
  console.log(`${String(i + 1).padStart(2)}. [${cluster.level}] ×${cluster.occurrences}${where}`);
  console.log(`    ${cluster.normalized.slice(0, 120)}`);
  if (frame0) console.log(`    frame: ${frame0.method} @ ${frame0.file}:${frame0.line ?? '?'}`);
}

if (wantBrief) {
  const out = new URL('./diag-brief.md', import.meta.url);
  fs.writeFileSync(out, analysis.brief, 'utf8');
  console.log(`\nbrief written: ${out.pathname} (${analysis.brief.length} chars)`);
}
