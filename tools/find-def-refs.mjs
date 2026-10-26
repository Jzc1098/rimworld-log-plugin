/**
 * Find which mods reference a def name, searching only mods that are enabled.
 *
 * Whole-workshop recursive scans have repeatedly stalled the tool, so this walks the active mod
 * list instead of the workshop roots. Every mod directory is known from ModsConfig, which keeps the
 * search bounded (hundreds of directories rather than tens of thousands).
 *
 * Usage: node find-def-refs.mjs <defName> [<defName> ...]
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const needles = process.argv.slice(2);
if (needles.length === 0) {
  console.error('usage: node find-def-refs.mjs <defName> [<defName> ...]');
  process.exit(2);
}

const env = detectEnvironment();
if (!env.profile) {
  console.error('no RimCrow profile found');
  process.exit(1);
}
const mods = activeModList(env.profile, env.config, {
  toolModRoots: env.home ? [path.join(env.home, 'toolmods')] : [],
});

console.log(`searching ${mods.activeCount} enabled mods for: ${needles.join(', ')}\n`);

const results = new Map(needles.map((n) => [n, []]));
let scanned = 0;
let files = 0;

for (const mod of mods.active) {
  if (!mod.installed || !mod.dir) continue;
  scanned += 1;
  // Only text formats can hold a def reference.
  const stack = [mod.dir];
  while (stack.length > 0) {
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
        // Skip assets that cannot contain def text; they dominate the file count.
        if (/^(\.git|Textures|Sounds|About|Languages|Source|obj|bin)$/i.test(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!/\.(xml|json|txt)$/i.test(entry.name)) continue;
      files += 1;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const needle of needles) {
        if (!text.includes(needle)) continue;
        // Distinguish a definition from a mere reference.
        const definesIt = new RegExp(`<defName>\\s*${needle}\\s*</defName>`).test(text);
        results.get(needle).push({
          mod: mod.packageId,
          name: mod.name,
          file: full.slice(mod.dir.length + 1),
          definesIt,
        });
      }
    }
  }
}

console.log(`scanned ${scanned} mod directories, ${files} text files\n`);
for (const needle of needles) {
  const hits = results.get(needle);
  console.log(`=== ${needle}  (${hits.length} file(s)) ===`);
  if (hits.length === 0) {
    console.log('  (no reference found in any enabled mod)');
    continue;
  }
  const defining = hits.filter((h) => h.definesIt);
  const referencing = hits.filter((h) => !h.definesIt);
  if (defining.length > 0) {
    console.log('  ▸ 定义它的:');
    for (const h of defining) console.log(`      ${h.name}  [${h.mod}]  ${h.file}`);
  } else {
    console.log('  ▸ 没有任何已启用 mod 定义它（这正是报错原因）');
  }
  if (referencing.length > 0) {
    console.log('  ▸ 引用它的:');
    for (const h of referencing.slice(0, 12)) console.log(`      ${h.name}  [${h.mod}]  ${h.file}`);
    if (referencing.length > 12) console.log(`      … 另有 ${referencing.length - 12} 处`);
  }
  console.log('');
}
