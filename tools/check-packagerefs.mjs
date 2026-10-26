// Verify that package ids referenced by my patches actually exist in the enabled mod list.
//
// The active list is read through the plugin's own detect module rather than by scanning folders,
// because that is the same source RimCrow reports "unresolved dependency" from, and because folder
// scanning produced false matches when two mods share a package id.
//
// Usage: node check-packagerefs.mjs <packageId> [<packageId> ...]

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detect = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'detect.js')).href);

const refs = process.argv.slice(2);
if (refs.length === 0) {
  console.error('usage: node check-packagerefs.mjs <packageId> [...]');
  process.exit(2);
}

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, {
  toolModRoots: [path.join(env.home ?? '', 'toolmods')],
});
const active = modlist.active ?? [];

/** packageId (lowercased) -> display name, from the enabled list only. */
const byId = new Map();
for (const m of active) {
  const id = String(m.packageId ?? '');
  if (!id) continue;
  byId.set(id.toLowerCase(), String(m.name ?? '?'));
}

console.log('enabled mods: ' + active.length + '   distinct package ids: ' + byId.size);
console.log('');

let missing = 0;
for (const ref of refs) {
  const name = byId.get(ref.toLowerCase());
  if (name !== undefined) {
    console.log('  OK    ' + ref.padEnd(46) + ' -> ' + name);
  } else {
    missing++;
    console.log('  MISS  ' + ref.padEnd(46) + ' <- not in the enabled list');
  }
}

console.log('');
console.log('missing: ' + missing + ' of ' + refs.length);
