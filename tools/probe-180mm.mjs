/**
 * Structural comparison for the 180mm_nade texture set.
 *
 * Two questions:
 *   1. what graphic class does the 180mm ammo def actually end up with, and who sets it
 *   2. among all enabled mods, which other defs use the SAME structure (a texture folder of
 *      _a/_b/_c variants referenced by a Graphic_StackCount/Collection graphicClass)
 *
 * Usage: node probe-180mm.mjs
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

console.log('=== 1. every def whose texPath points at Things/Ammo/180mm_nade ===');
for (const [dir, name] of roots) {
  const stack = [dir];
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
      if (!text.includes('180mm_nade')) continue;
      for (const m of text.matchAll(/<ThingDef\b.*?<\/ThingDef>/gs)) {
        const block = m[0];
        if (!block.includes('180mm_nade')) continue;
        const dn = /<defName>([^<]+)<\/defName>/.exec(block);
        const gc = /<graphicClass>([^<]+)<\/graphicClass>/.exec(block);
        const tp = /<texPath>([^<]+)<\/texPath>/.exec(block);
        console.log(`  ${name}  ${full.replace(dir, '')}`);
        console.log(`      defName      = ${dn ? dn[1] : '(abstract)'}`);
        console.log(`      graphicClass = ${gc ? gc[1] : '(none)'}`);
        console.log(`      texPath      = ${tp ? tp[1] : '(none)'}`);
      }
    }
  }
}

console.log('\n=== 2. which C# types in enabled mods inherit Verse.Graphic_Collection? ===');
console.log('  (looking for a mod that overrides the graphic for ammo)');
const dlls = [];
for (const [dir, name] of roots) {
  const stack = [dir];
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
        if (/^(Textures|Sounds|Languages|\.git)$/i.test(e.name)) continue;
        stack.push(full);
      } else if (e.name.toLowerCase().endsWith('.dll')) {
        dlls.push({ file: full, mod: name });
      }
    }
  }
}
console.log(`  candidate assemblies: ${dlls.length}`);

// Only the assembly NAME matters here, and that is a UTF-8 string in the metadata; checking for
// the literal type name as UTF-8 avoids loading every assembly.
for (const { file, mod } of dlls) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    continue;
  }
  const hasCollection = buf.includes(Buffer.from('Graphic_Collection', 'utf8'));
  const hasStackCount = buf.includes(Buffer.from('Graphic_StackCount', 'utf8'));
  if (hasCollection || hasStackCount) {
    console.log(`  ${mod}`);
    console.log(`      ${path.basename(file)}   Graphic_Collection=${hasCollection}  Graphic_StackCount=${hasStackCount}`);
  }
}
