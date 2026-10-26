// Find which cluster a specific log message ends up in, and what that cluster reports.
//
// Written to explain a wrong "mods where errors are concentrated" entry: a startup INFO record that
// lists updated mod names was showing up under a heading about errors. Clustering merges entries by
// message template and takes the most severe level in the group, so an INFO record can ride along
// inside an ERROR cluster -- and if that cluster names mods, they are tallied as errors.
//
// Usage: node trace-cluster.mjs <profile dir> <substring of the message>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const needle = process.argv[3];
if (!profileDir || !needle) {
  console.error('usage: node trace-cluster.mjs <profile dir> <substring>');
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

const raw = fs.readFileSync(path.join(profileDir, 'RimCrow_Realtime.log'), 'utf8').split('\n').filter(Boolean);
const entries = [];
for (const line of raw) {
  try {
    const o = JSON.parse(line);
    entries.push({
      timestamp: o.timestamp,
      level: o.level,
      message: o.message ?? '',
      details: o.details ?? '',
      count: o.count ?? 1,
      relatedModIds: o.context?.relatedModIds ?? [],
      relatedFiles: o.context?.relatedFiles ?? [],
    });
  } catch { /* skip */ }
}

const clusters = parse.clusterProblems(entries, modRoots, active, env.indexes ?? {});
console.log('total clusters: ' + clusters.length);

// Which clusters contain an entry whose message includes the needle?
const owning = clusters.filter((c) =>
  (c.entries ?? []).some((e) => String(e.message).includes(needle))
  || String(c.sample ?? '').includes(needle)
  || (c.messages ?? []).some?.((m) => String(m).includes(needle)));
console.log('clusters containing "' + needle + '": ' + owning.length);
console.log('');

for (const c of owning) {
  console.log('=== cluster');
  console.log('  level       : ' + c.level);
  console.log('  occurrences : ' + c.occurrences);
  console.log('  modIds      : ' + JSON.stringify(c.modIds));
  console.log('  keys        : ' + Object.keys(c).join(', '));
  const members = c.entries ?? [];
  console.log('  members     : ' + members.length);
  const byLevel = {};
  for (const m of members) byLevel[m.level] = (byLevel[m.level] ?? 0) + 1;
  console.log('  by level    : ' + JSON.stringify(byLevel));
  for (const m of members.slice(0, 8)) {
    console.log('     [' + m.level + '] ' + String(m.message).slice(0, 100).replace(/\n/g, ' '));
  }
}
