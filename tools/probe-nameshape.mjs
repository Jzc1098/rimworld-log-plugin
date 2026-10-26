/**
 * What exactly is the loader looking for, and does the base-name shape matter?
 *
 * Graphic_Collection.Init calls ContentFinder<Texture2D>.GetAllInFolder(path), which returns every
 * texture whose name starts with <lastSegmentOfPath> + "_". This script:
 *   1. enumerates every texture folder in the enabled mods
 *   2. classifies the base name (the part before _a/_b/_c) as alphabetic-only or containing digits
 *   3. reports which mod owns them, so the failing case can be compared by name shape
 *
 * Usage: node probe-nameshape.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });

const roots = new Map();
for (const m of mods.active) {
  if (!m.installed || !m.dir) continue;
  let real = m.dir;
  try {
    real = fs.realpathSync(m.dir);
  } catch {
    /* keep original */
  }
  if (!roots.has(real)) roots.set(real, m.name);
}

/** Walk a mod's Textures folder and group files by "name with the trailing _x.png removed". */
function groups(modDir) {
  const out = [];
  const stack = [path.join(modDir, 'Textures')];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const byBase = new Map();
    for (const e of entries) {
      if (e.isDirectory()) {
        stack.push(path.join(dir, e.name));
        continue;
      }
      const mm = /^(.*)_([a-z])\.png$/i.exec(e.name);
      if (!mm) continue;
      const base = mm[1];
      if (!byBase.has(base)) byBase.set(base, { dir, letters: [], base });
      byBase.get(base).letters.push(mm[2].toLowerCase());
    }
    for (const g of byBase.values()) {
      if (g.letters.length >= 2) out.push(g);
    }
  }
  return out;
}

const alphaOnly = [];
const withDigits = [];
for (const [modDir, modName] of roots) {
  for (const g of groups(modDir)) {
    const rec = {
      mod: modName,
      base: g.base,
      letters: g.letters.sort().join(''),
      folder: path.relative(modDir, g.dir).replace(/\\/g, '/'),
      folderName: path.basename(g.dir),
    };
    if (/[0-9]/.test(g.base)) withDigits.push(rec);
    else alphaOnly.push(rec);
  }
}

console.log(`=== base names containing a DIGIT (${withDigits.length}) ===`);
const byModDigits = new Map();
for (const r of withDigits) {
  if (!byModDigits.has(r.mod)) byModDigits.set(r.mod, []);
  byModDigits.get(r.mod).push(r);
}
for (const [mod, list] of [...byModDigits.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${mod}  (${list.length})`);
  for (const r of list.slice(0, 6)) {
    console.log(`      base="${r.base}"  letters=${r.letters}  folder="${r.folderName}"  folder==base? ${r.folderName === r.base}`);
  }
  if (list.length > 6) console.log(`      ... ${list.length - 6} more`);
}

console.log(`\n=== alphabetic-only base names (${alphaOnly.length}) - top mods ===`);
const byModAlpha = new Map();
for (const r of alphaOnly) {
  byModAlpha.set(r.mod, (byModAlpha.get(r.mod) ?? 0) + 1);
}
for (const [mod, n] of [...byModAlpha.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${mod}  (${n})`);
}

console.log('\n=== the failing case, same fields ===');
console.log('  base="HEAT180AT97"  letters=abc  folder="180mm_nade"  folder==base? false   (has digits: yes)');
console.log('  for comparison, the working sibling:');
console.log('  base="MeltaGun"     letters=abc  folder="MeltaGun"     folder==base? true    (has digits: no)');

console.log('\n=== how many DIGIT-bearing base names does Combat Extended itself use? ===');
const ceDigits = withDigits.filter((r) => r.mod === 'Combat Extended');
console.log(`  ${ceDigits.length}`);
for (const r of ceDigits.slice(0, 12)) {
  console.log(`      base="${r.base}"  folder="${r.folderName}"  folder==base? ${r.folderName === r.base}`);
}
