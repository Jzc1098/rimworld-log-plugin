// Reproduce how a cluster that merely MENTIONS a mod gets attributed to it.
//
// Written after an analysis brief listed the plugin's own guard patches under "mods with errors",
// even though their log lines are INFO. Two things had to be separated: whether the cluster is an
// error at all, and whether attribution was reached from a frame (real evidence) or from the message
// text naming a mod (weak evidence that fires on any line containing the mod's name).
//
// Usage: node probe-cluster-attribution.mjs <RimCrow profile dir> <substring>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const needle = process.argv[3] ?? 'RigorMortis';

// fileURLToPath, not URL.pathname: the workspace path contains spaces and non-ASCII, and pathname
// leaves them percent-encoded, which then gets encoded a second time by pathToFileURL.
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;

const detect = await import(lib('detect.js'));
const parse = await import(lib('parse.js'));

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, { toolModRoots: [env.home + '\\toolmods'] });
const active = modlist.active ?? [];
const modRoots = modlist.modRoots ?? [];

console.log('profile   : ' + (env.profile?.name ?? '(none)'));
console.log('active    : ' + active.length + ' mods');
console.log('modRoots  : ' + modRoots.length);
console.log('needle    : ' + needle);
console.log('');

const logPath = path.join(profileDir, 'RimCrow_Realtime.log');
const raw = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

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
  } catch {
    // skip unparseable
  }
}
console.log('parsed entries: ' + entries.length);

const hits = entries.filter((e) => String(e.message).includes(needle) || String(e.details).includes(needle));
console.log('entries mentioning "' + needle + '": ' + hits.length);
console.log('');
for (const e of hits.slice(0, 12)) {
  console.log('  level=' + e.level + '  count=' + e.count);
  console.log('    msg: ' + String(e.message).slice(0, 130).replace(/\n/g, ' '));
}
console.log('');

// Now cluster only those entries and see what attribution they receive.
const clusters = parse.clusterProblems(hits, modRoots, active, env.indexes ?? {});
console.log('clusters formed: ' + clusters.length);
console.log('');
for (const c of clusters) {
  console.log('  --- cluster');
  console.log('      severity   : ' + (c.severity ?? c.level ?? '(none)'));
  console.log('      occurrences: ' + c.occurrences);
  console.log('      message    : ' + String(c.sample ?? c.message ?? '').slice(0, 120).replace(/\n/g, ' '));
  const mod = parse.resolveMod(c, modRoots, active, env.indexes ?? {});
  if (mod) {
    console.log('      ATTRIBUTED : ' + mod.name + ' [' + mod.packageId + ']  confidence=' + mod.confidence);
    console.log('      evidence   : ' + mod.evidence);
  } else {
    console.log('      ATTRIBUTED : (none)');
  }
}
