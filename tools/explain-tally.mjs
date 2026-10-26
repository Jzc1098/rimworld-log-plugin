// Reproduce the report's per-mod error tally and show exactly which clusters produced each entry.
//
// Written because a mod name appeared under "mods where errors are concentrated" and neither the raw
// message search nor a normalized-cluster search explained it. Attribution can come from a stack frame
// path rather than the message text, so the only reliable way to explain the number is to recompute the
// tally and print the contributing clusters.
//
// Usage: node explain-tally.mjs <profile dir> [substring of the mod name to explain]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const want = (process.argv[3] ?? '').toLowerCase();
if (!profileDir) {
  console.error('usage: node explain-tally.mjs <profile dir> [mod name substring]');
  process.exit(2);
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const detect = await import(lib('detect.js'));
const parse = await import(lib('parse.js'));

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, { toolModRoots: [env.home + '\\toolmods'] });
const active = modlist.active ?? [];
const modRoots = modlist.modRoots ?? [];

const raw = fs.readFileSync(path.join(profileDir, 'RimCrow_Realtime.log'), 'utf8').split('\n');
// parseRealtimeLine, not JSON.parse: it is what uppercases `level`, extracts `frames` from `details`
// and fills `inferredType`. Handing clusterProblems raw JSON objects silently yields zero clusters,
// because every entry then fails isProblemLevel and is skipped.
const entries = raw.map((line) => parse.parseRealtimeLine(line)).filter(Boolean);

const clusters = parse.clusterProblems(entries, modRoots, active, env.indexes ?? {});

// Same tally as report.js: only ERROR and WARNING clusters, keyed by relatedModIds and attribution.
const tally = new Map();
const contributors = new Map();
for (const cluster of clusters) {
  const rank = parse.levelRank(cluster.level);
  if (rank > 2) continue;
  const keys = [...cluster.modIds];
  if (cluster.mod) keys.push(cluster.mod.packageId || cluster.mod.name);
  for (const key of keys) {
    if (!key) continue;
    tally.set(key, (tally.get(key) ?? 0) + cluster.occurrences);
    if (!contributors.has(key)) contributors.set(key, []);
    contributors.get(key).push(cluster);
  }
}

const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
console.log('tallied keys: ' + sorted.length);
console.log('');
console.log('=== top 15 ===');
for (const [key, count] of sorted.slice(0, 15)) {
  console.log('  x' + String(count).padStart(4) + '  ' + key);
}

if (want) {
  console.log('');
  console.log('=== clusters contributing to keys containing "' + want + '" ===');
  for (const [key, list] of contributors) {
    if (!key.toLowerCase().includes(want)) continue;
    console.log('');
    console.log('KEY: ' + key + '   total=x' + tally.get(key) + '   from ' + list.length + ' cluster(s)');
    for (const c of list) {
      console.log('  [' + c.level + '] x' + c.occurrences);
      console.log('      modIds      : ' + JSON.stringify([...c.modIds]));
      console.log('      attribution : ' + (c.mod ? c.mod.name + ' [' + c.mod.packageId + '] conf=' + c.mod.confidence : '(none)'));
      console.log('      evidence    : ' + (c.mod?.evidence ?? ''));
      console.log('      norm        : ' + String(c.normalized).slice(0, 160));
      for (const s of (c.samples ?? []).slice(0, 2)) {
        console.log('      raw         : ' + String(s).slice(0, 160).replace(/\n/g, ' | '));
      }
    }
  }
}
