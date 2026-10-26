/**
 * Find every ammo/thing texture set that uses the _a/_b/_c variant naming, and report which ones
 * RimWorld managed to load. If others with the same shape work, the naming convention is fine and
 * the 180mm case is an outlier.
 *
 * Usage: node probe-variants.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });

/** Collect texture folders that contain any *_a.png, i.e. a Graphic_Collection candidate. */
function scanVariants(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase());
    const hasA = files.some((f) => /_a\.png$/.test(f));
    if (hasA) {
      const variants = files.filter((f) => /_[a-z]\.png$/.test(f)).sort();
      found.push({ dir, variants });
      continue;
    }
    for (const e of entries) if (e.isDirectory()) stack.push(path.join(dir, e.name));
  }
  return found;
}

// Textures live under the real mod directory. Symlinked _Link_* entries are aliases, so walk the
// distinct real roots only.
const roots = new Map();
for (const m of mods.active) {
  if (!m.installed || !m.dir) continue;
  let real = m.dir;
  try {
    real = fs.realpathSync(m.dir);
  } catch {
    /* keep the original path */
  }
  if (!roots.has(real)) roots.set(real, m.name);
}

console.log(`distinct real mod directories: ${roots.size}\n`);

const perMod = [];
for (const [dir, name] of roots) {
  const tex = path.join(dir, 'Textures');
  if (!fs.existsSync(tex)) continue;
  const sets = scanVariants(tex);
  if (sets.length > 0) perMod.push({ name, dir, sets });
}

console.log(`=== mods whose textures use the _a/_b/_c variant scheme (${perMod.length}) ===`);
perMod.sort((a, b) => b.sets.length - a.sets.length);
for (const m of perMod.slice(0, 12)) {
  console.log(`  ${m.name}  (${m.sets.length} set(s))`);
  for (const s of m.sets.slice(0, 3)) {
    const rel = s.dir.replace(m.dir, '').replace(/\\/g, '/');
    console.log(`      ${rel}   [${s.variants.join(' ')}]`);
  }
  if (m.sets.length > 3) console.log(`      ... ${m.sets.length - 3} more`);
}

// Narrow to the specific case: single-letter variants with exactly 3 files.
console.log('\n=== sets with exactly three single-letter variants ===');
let count = 0;
for (const m of perMod) {
  for (const s of m.sets) {
    const letters = s.variants.filter((v) => /_[abc]\.png$/.test(v));
    if (letters.length === 3 && new Set(s.variants.map((v) => v.replace(/_[a-z]\.png$/, ''))).size === 1) {
      count += 1;
      if (count <= 10) console.log(`  ${m.name}\n      ${s.dir.replace(m.dir, '').replace(/\\/g, '/')}   [${s.variants.join(' ')}]`);
    }
  }
}
console.log(`  total: ${count}`);

// The failing one, for direct comparison.
console.log('\n=== the failing set ===');
// 工坊内容根（公开版不写死本机路径）：WORKSHOP_DIR=<steamapps\workshop\content\294100>
const bad = process.env.WORKSHOP_DIR
  ? path.join(process.env.WORKSHOP_DIR, '3679716499', 'Textures', 'Things', 'Ammo', '180mm_nade')
  : undefined;
if (!bad) {
  console.error('请设置 WORKSHOP_DIR（Steam 工坊 294100 目录）');
  process.exit(2);
}
if (fs.existsSync(bad)) {
  for (const f of fs.readdirSync(bad)) console.log(`  ${f}`);
} else {
  console.log('  folder missing');
}
