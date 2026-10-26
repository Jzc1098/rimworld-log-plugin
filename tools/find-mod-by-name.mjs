// Locate which enabled mod provides an assembly or a def name.
//
// Written after two recursive whole-disk searches timed out. The plugin already indexes every mod
// directory, so resolving through that index is both faster and bounded.
//
// Usage:
//   node find-mod-by-name.mjs --dll FuncAmmo
//   node find-mod-by-name.mjs --pkg vehicle
//   node find-mod-by-name.mjs --name GrayKnights

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (n) => pathToFileURL(path.join(pluginRoot, 'lib', n)).href;
const detect = await import(lib('detect.js'));

const args = process.argv.slice(2);
const mode = args[0] ?? '--pkg';
const needle = (args[1] ?? '').toLowerCase();

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, {
  toolModRoots: [path.join(env.home ?? '', 'toolmods')],
});
const active = modlist.active ?? [];
console.log('enabled mods: ' + active.length);
console.log('mode=' + mode + '  needle=' + needle);
console.log('');

const hits = [];
for (const mod of active) {
  const pkg = String(mod.packageId ?? '');
  const name = String(mod.name ?? '');
  const dir = String(mod.dir ?? '');

  if (mode === '--pkg' && (pkg.toLowerCase().includes(needle) || name.toLowerCase().includes(needle))) {
    hits.push({ why: 'packageId/name', mod });
    continue;
  }
  if (mode === '--dll') {
    const assemblies = mod.assemblies ?? [];
    const match = assemblies.filter((a) => String(a).toLowerCase().includes(needle));
    if (match.length) hits.push({ why: 'assembly: ' + match.join(', '), mod });
    continue;
  }
  if (mode === '--name') {
    // Folder name is cheap; a def-name search inside files is not, so only check the folder here.
    const folder = path.basename(dir).toLowerCase();
    if (folder.includes(needle)) hits.push({ why: 'folder', mod });
  }
}

console.log('hits: ' + hits.length);
for (const h of hits) {
  console.log('  [' + h.why + ']');
  console.log('    pkg  : ' + h.mod.packageId);
  console.log('    name : ' + h.mod.name);
  console.log('    dir  : ' + h.mod.dir);
  if (h.mod.assemblies?.length) {
    console.log('    dlls : ' + h.mod.assemblies.join(', '));
  }
}

if (mode === '--dll') {
  console.log('');
  console.log('-- every enabled mod that ships any assembly --');
  let withDll = 0;
  for (const mod of active) if ((mod.assemblies ?? []).length) withDll++;
  console.log('  mods with assemblies: ' + withDll + ' / ' + active.length);
}
