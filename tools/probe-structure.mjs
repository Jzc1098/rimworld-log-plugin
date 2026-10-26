/**
 * Structural horizontal comparison for the 180mm_nade case.
 *
 * Target structure:
 *   a concrete ammo ThingDef
 *     + <graphicClass>Graphic_StackCount</graphicClass>
 *     + <texPath> pointing at a FOLDER that holds exactly NAME_a.png, NAME_b.png, NAME_c.png
 *     + the def itself carrying the CE_AutoEnableCrafting_GWAmmoBench tag
 *
 * Reports every def with that shape so the 180mm case can be compared against siblings.
 *
 * Usage: node probe-structure.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolRoots: undefined, toolModRoots: [`${env.home}\\toolmods`] });

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

/** Does <mod>/Textures/<texPath>_{a,b,c}.png exist, and only those? */
function variantSetOf(modDir, texPath) {
  const dir = path.join(modDir, 'Textures', ...texPath.split('/'));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const pngs = entries.filter((e) => e.toLowerCase().endsWith('.png'));
  if (pngs.length === 0) return null;
  const base = texPath.split('/').pop().toLowerCase();
  const letters = {};
  for (const p of pngs) {
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_([a-z])\\.png$`, 'i').exec(p);
    if (m) letters[m[1].toLowerCase()] = p;
    else letters[`?${p}`] = p;
  }
  return { dir, pngs, letters };
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

const matches = [];
for (const [modDir, modName] of roots) {
  const stack = [modDir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (/^(Textures|Sounds|\.git)$/i.test(e.name)) continue;
        stack.push(full);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.xml')) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('Graphic_StackCount')) continue;
      for (const m of text.matchAll(/<ThingDef\b.*?<\/ThingDef>/gs)) {
        const block = m[0];
        const gc = /<graphicClass>\s*Graphic_StackCount\s*<\/graphicClass>/.exec(block);
        if (!gc) continue;
        const dn = /<defName>\s*([^<\s]+)\s*<\/defName>/.exec(block);
        if (!dn) continue;
        const tp = /<texPath>\s*([^<\s]+)\s*<\/texPath>/.exec(block);
        if (!tp) continue;
        const info = variantSetOf(modDir, tp[1]);
        if (!info) continue;
        matches.push({
          mod: modName,
          modDir,
          file: full.replace(modDir, ''),
          defName: dn[1],
          texPath: tp[1],
          hasBenchTag: block.includes('CE_AutoEnableCrafting_GWAmmoBench'),
          letters: info.letters,
          dir: info.dir,
          pngs: info.pngs,
        });
      }
    }
  }
}

console.log(`=== every Graphic_StackCount def whose texPath is a real texture folder (${matches.length}) ===\n`);
for (const m of matches) {
  const l = Object.keys(m.letters).filter((k) => /^[a-z]$/.test(k)).sort().join('');
  const extra = Object.keys(m.letters).filter((k) => k.startsWith('?'));
  console.log(`  ${m.defName}`);
  console.log(`      mod          ${m.mod}`);
  console.log(`      graphicClass Graphic_StackCount`);
  console.log(`      texPath      ${m.texPath}`);
  console.log(`      variants     ${l || '(none)'}${extra.length ? '  extra: ' + extra.join(' ') : ''}   files=${m.pngs.length}`);
  console.log(`      GWAmmoBench  ${m.hasBenchTag}`);
}

console.log('\n=== the 180mm set, in the same shape ===');
// 工坊内容根（公开版不写死本机路径）：WORKSHOP_DIR=<steamapps\workshop\content\294100>
if (!process.env.WORKSHOP_DIR) {
  console.error('请设置 WORKSHOP_DIR（Steam 工坊 294100 目录）');
  process.exit(2);
}
const bad = {
  defName: 'Ammo_180mm_nade_HEAT',
  texPath: 'Things/Ammo/180mm_nade/HEAT180AT97',
  dir: path.join(process.env.WORKSHOP_DIR, '3679716499', 'Textures', 'Things', 'Ammo', '180mm_nade'),
};
const badFiles = fs.readdirSync(bad.dir).sort();
console.log(`  ${bad.defName}`);
console.log(`      mod          Kiiro EXTRA Calibers 绮械拓展`);
console.log(`      graphicClass Graphic_StackCount`);
console.log(`      texPath      ${bad.texPath}`);
console.log(`      variants     ${badFiles.map((f) => f.replace(/.*_([a-z])\.png$/i, '$1')).sort().join('')}   files=${badFiles.length}`);

console.log('\n=== are the three 180mm images actually distinct? ===');
const hashes = {};
for (const f of badFiles) {
  const h = md5(path.join(bad.dir, f));
  hashes[f] = h;
  console.log(`  ${f}   md5=${h.slice(0, 12)}`);
}
const uniqueHashes = new Set(Object.values(hashes));
console.log(`  distinct images: ${uniqueHashes.size} of ${badFiles.length}`);

console.log('\n=== compare one healthy sibling the same way ===');
const healthy = matches.find((m) => Object.keys(m.letters).filter((k) => /^[a-z]$/.test(k)).length === 3);
if (healthy) {
  console.log(`  ${healthy.defName}   (${healthy.mod})`);
  for (const f of healthy.pngs.sort()) {
    const h = md5(path.join(healthy.dir, f));
    console.log(`      ${f}   md5=${h.slice(0, 12)}`);
  }
}
