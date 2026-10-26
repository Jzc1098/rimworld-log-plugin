/**
 * Attribute the remaining "CE ammo injector found no recipe named X" errors.
 *
 * These are separate from the Kiiro bench work: the recipes genuinely do not exist, so CE cannot
 * inject an ammunition into them. This finds which enabled mod owns each name.
 *
 * Usage: node attribute-recipes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });

const wanted = [
  'MakeShell_AntigrainWarhead',
  'MakeAmmo_RK_DragonAmmo_Normal',
  'MakeAmmo_RK_DragonAmmo_Flame',
  'MakeAmmo_155mmHowitzerShell_Anti',
];

// Search terms derived from each name: the recipe, plus the def it would produce.
const terms = new Map();
for (const w of wanted) {
  const stem = w.replace(/^Make(Shell|Ammo)_/, '');
  terms.set(w, [w, stem]);
}

const enabled = mods.active.filter((m) => m.installed && m.dir);
console.log(`scanning ${enabled.length} enabled mod directories\n`);

const hits = new Map(wanted.map((w) => [w, []]));
let scanned = 0;

for (const mod of enabled) {
  const stack = [mod.dir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(Textures|Sounds|\.git)$/i.test(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.xml')) continue;
      scanned += 1;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const [recipe, needles] of terms) {
        for (const needle of needles) {
          if (text.includes(needle)) {
            hits.get(recipe).push({
              mod: mod.name,
              packageId: mod.packageId,
              file: full.replace(mod.dir, ''),
              needle,
            });
            break;
          }
        }
      }
    }
  }
}

console.log(`xml files scanned: ${scanned}\n`);
console.log('=== attribution ===');
for (const w of wanted) {
  const list = hits.get(w);
  console.log(`\n  ${w}`);
  if (list.length === 0) {
    console.log('      no enabled mod mentions it (likely generated at runtime by CE)');
    continue;
  }
  const byMod = new Map();
  for (const h of list) {
    const key = `${h.mod}  [${h.packageId}]`;
    if (!byMod.has(key)) byMod.set(key, []);
    byMod.get(key).push(h);
  }
  for (const [mod, entries] of byMod) {
    console.log(`      ${mod}`);
    for (const e of entries.slice(0, 4)) console.log(`          ${e.file}   (matched "${e.needle}")`);
    if (entries.length > 4) console.log(`          ... ${entries.length - 4} more`);
  }
}
