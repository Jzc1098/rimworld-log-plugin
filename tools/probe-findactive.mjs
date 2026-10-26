// Show which active mod a namespace token resolves to, and why.
//
// Written to explain a wrong attribution: the token `RigorMortis` (taken from a stack frame namespace)
// was resolving to a patch mod named `Fix - Rigor Mortis null pawn` rather than to the mod that
// actually owns the namespace. Printing every active mod whose spellings contain the token, in the
// order the resolver would consider them, makes the winner and its runner-up obvious.
//
// Usage: node probe-findactive.mjs <profile dir> <token>

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
const token = process.argv[3];
if (!profileDir || !token) {
  console.error('usage: node probe-findactive.mjs <profile dir> <token>');
  process.exit(2);
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const detect = await import(lib('detect.js'));

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, { toolModRoots: [env.home + '\\toolmods'] });
const active = modlist.active ?? [];

const key = String(token).toLowerCase().replace(/[\s_-]+/g, '');
console.log('token      : ' + token);
console.log('normalized : ' + key);
console.log('active     : ' + active.length + ' mods');
console.log('');

const shapes = (mod) => {
  const folder = String(mod.dir ?? '').split(/[\\/]/).pop() ?? '';
  return { name: String(mod.name ?? ''), folder, packageId: String(mod.packageId ?? '') };
};
// Mirrors resolveMod's atBoundary exactly, so this probe explains the real resolver rather than a
// re-implementation of it.
const atBoundary = (value, k) => {
  const spaced = String(value).toLowerCase().replace(/[\s_\-.]+/g, ' ').trim();
  const flat = spaced.replace(/ /g, '');
  if (flat === k) return true;
  if (!flat.includes(k)) return false;
  let index = 0;
  for (const word of spaced.split(' ')) {
    if (flat.slice(index).startsWith(k)) return true;
    index += word.length;
  }
  return false;
};

const contains = [];
for (const mod of active) {
  const s = shapes(mod);
  const values = [s.name, s.folder, s.packageId];
  const flat = values.map((v) => v.toLowerCase().replace(/[\s_-]+/g, ''));
  if (!flat.some((v) => v.includes(key))) continue;
  const exact = flat.some((v) => v === key);
  const boundary = values.some((v) => atBoundary(v, key));
  contains.push({ exact, boundary, ...s });
}

console.log('mods whose name/folder/packageId contain the token: ' + contains.length);
console.log('');
const show = (label, rows) => {
  console.log('--- ' + label + ' (' + rows.length + ')');
  for (const r of rows) {
    console.log('    name="' + r.name + '"  folder="' + r.folder + '"  pkg="' + r.packageId + '"');
  }
};
show('EXACT', contains.filter((r) => r.exact));
show('BOUNDARY', contains.filter((r) => !r.exact && r.boundary));
show('CONTAINS only', contains.filter((r) => !r.exact && !r.boundary));
