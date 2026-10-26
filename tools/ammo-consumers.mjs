/**
 * Who consumes the Warhammer 40k ammunition that references GWAmmoBench?
 *
 * Answers whether the error is caused by an enabled mod that needs this ammo, or whether the
 * ammo is orphaned in CE and nothing in the load order can fire it.
 *
 * Usage: node ammo-consumers.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });

// Ammo sets and ammo defs CE declares for 40k, straight from the files that carry the tag.
// The mod directory is machine-specific, so it comes from CE_MOD_DIR rather than a literal:
//   CE_MOD_DIR=<steamapps\workshop\content\294100>\2890901044
const CE = process.env.CE_MOD_DIR;
if (!CE) {
  console.error('请设置 CE_MOD_DIR（Combat Extended 的 mod 目录，如 ...\\workshop\\content\\294100\\2890901044）');
  process.exit(2);
}
const ammoDir = path.join(CE, 'Defs', 'Ammo', 'Modded', 'Warhammer 40k');
const ammoSets = new Set();
const ammoDefs = new Set();
for (const file of fs.readdirSync(ammoDir)) {
  if (!file.endsWith('.xml')) continue;
  const text = fs.readFileSync(path.join(ammoDir, file), 'utf8');
  if (!text.includes('CE_AutoEnableCrafting_GWAmmoBench')) continue;
  for (const m of text.matchAll(/<defName>(AmmoSet_[A-Za-z0-9_]+)<\/defName>/g)) ammoSets.add(m[1]);
  for (const m of text.matchAll(/<defName>(Ammo_[A-Za-z0-9_]+)<\/defName>/g)) ammoDefs.add(m[1]);
}
console.log('=== the 40k ammo CE declares (tagged for GWAmmoBench) ===');
console.log('ammo sets :', [...ammoSets].join(', '));
console.log('ammo defs :', [...ammoDefs].slice(0, 20).join(', '), ammoDefs.size > 20 ? `... (${ammoDefs.size} total)` : '');

// Scan only the ENABLED mods, and only for AmmoUser references to those sets.
const enabled = mods.active.filter((m) => m.installed && m.dir);
console.log(`\nscanning ${enabled.length} enabled mod directories for consumers...`);

const consumers = [];
let scanned = 0;
for (const mod of enabled) {
  const stack = [mod.dir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Textures and languages hold no defs; skipping them keeps this quick.
        if (/^(Textures|Languages|Sounds|Source|\.git)$/i.test(entry.name)) continue;
        stack.push(full);
      } else if (entry.name.toLowerCase().endsWith('.xml')) {
        scanned += 1;
        let text;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (!text.includes('AmmoSet_Bolter') && !text.includes('AmmoSet_Lasgun')
          && !text.includes('AmmoSet_Melta') && !text.includes('AmmoSet_PlasmaCanister')
          && !text.includes('Ammo_Bolter') && !text.includes('Ammo_Lasgun')
          && !text.includes('Ammo_MeltaGun') && !text.includes('Ammo_PlasmaCannon')) continue;
        const hits = new Set();
        for (const s of ammoSets) if (text.includes(s)) hits.add(s);
        if (hits.size > 0) {
          consumers.push({
            mod: mod.name,
            packageId: mod.packageId,
            file: full.replace(mod.dir, ''),
            sets: [...hits],
          });
        }
      }
    }
  }
}

console.log(`xml files scanned: ${scanned}`);
console.log(`\n=== ENABLED mods that reference this ammunition ===`);
if (consumers.length === 0) {
  console.log('  (none - nothing in the active load order fires this ammo)');
} else {
  const byMod = new Map();
  for (const c of consumers) {
    if (!byMod.has(c.mod)) byMod.set(c.mod, []);
    byMod.get(c.mod).push(c);
  }
  for (const [mod, list] of byMod) {
    console.log(`  ${mod}  [${list[0].packageId}]`);
    for (const c of list.slice(0, 6)) console.log(`      ${c.file}  -> ${c.sets.join(', ')}`);
    if (list.length > 6) console.log(`      ... ${list.length - 6} more`);
  }
}

console.log('');
console.log('=== remember: the AMMO itself is declared by ===');
console.log('  Combat Extended (always loaded)');
console.log('=== and the BENCH is declared only when ===');
console.log('  Grimworld.Core is active  (CE LoadFolders.xml)');

// Is AstraMilitarum enabled at all?
for (const id of ['Grimworld.AstraMilitarum', 'Grimworld.Core', 'KiiroSeries.CEIntegration', 'Kiiro.EXTRA.caliber']) {
  const hit = mods.active.find((m) => m.packageId.toLowerCase() === id.toLowerCase());
  console.log(`\n  ${id.padEnd(30)} ${hit ? (hit.installed ? 'ENABLED' : 'enabled but not installed') : 'not enabled'}`);
}
