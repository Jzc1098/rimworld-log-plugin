// List every cluster with its level, occurrences and normalized message, so a wrong tally entry can
// be traced to the cluster that produced it.
//
// Clustering stores a normalized (lowercased, id-stripped) message, not the raw sample, so searching
// the raw text for a mod name does not find the owning cluster. This prints the decoded clusters
// instead.
//
// Usage: node dump-clusters.mjs <profile dir> [substring filter]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const filter = process.argv[3] ?? '';
if (!profileDir) {
  console.error('usage: node dump-clusters.mjs <profile dir> [substring]');
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

// parseRealtimeLine, not raw JSON: it uppercases `level`, extracts `frames` from `details` and fills
// `inferredType`. Feeding clusterProblems raw JSON objects yields zero clusters, because every entry
// then fails isProblemLevel and is skipped.
const entries = fs.readFileSync(path.join(profileDir, 'RimCrow_Realtime.log'), 'utf8')
  .split('\n')
  .map((line) => parse.parseRealtimeLine(line))
  .filter(Boolean);

const clusters = parse.clusterProblems(entries, modRoots, active, env.indexes ?? {});
console.log('total clusters: ' + clusters.length);
console.log('');

const filtered = filter
  ? clusters.filter((c) => String(c.normalized).includes(filter.toLowerCase()))
  : clusters;

for (const c of filtered) {
  const own = c.mod ? `${c.mod.name} [${c.mod.packageId}] conf=${c.mod.confidence}` : '(none)';
  console.log('[' + c.level + '] x' + c.occurrences + '  modIds=' + JSON.stringify([...c.modIds]) + '  attribution=' + own);
  console.log('    norm : ' + String(c.normalized).slice(0, 150));
  for (const s of (c.samples ?? []).slice(0, 2)) {
    console.log('    raw  : ' + String(s).slice(0, 150).replace(/\n/g, ' | '));
  }
  if (process.env.DUMP_FRAMES) {
    for (const f of (c.frames ?? []).slice(0, 10)) {
      console.log('    frame: ' + String(f.method ?? '').slice(0, 100));
      console.log('           ' + String(f.file ?? '').slice(0, 140));
    }
  }
  console.log('');
}
