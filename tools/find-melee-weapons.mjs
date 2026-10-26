/**
 * Find melee weapons matching a keyword across enabled mods, and report their tool data.
 *
 * The point is to find a same-kind weapon that already has a Combat Extended patch, so a new patch
 * can be modelled on a real precedent rather than extrapolated. For each hit this reports both the
 * weapon's own tools and any ToolCE conversion of them, which is exactly the before/after pair
 * needed to see how the same weapon shape is translated into CE.
 *
 * Usage: node find-melee-weapons.mjs <keyword> [...]
 *
 * Scoped to mods that are actually enabled (456 here), not the whole workshop, because recursing the
 * entire workshop has repeatedly stalled this tool.
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const keywords = process.argv.slice(2).map((k) => k.toLowerCase());
if (keywords.length === 0) {
  console.error('usage: node find-melee-weapons.mjs <keyword> [...]');
  process.exit(2);
}

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, {
  toolModRoots: env.home ? [path.join(env.home, 'toolmods')] : [],
});
console.log(`searching ${mods.activeCount} enabled mods for: ${keywords.join(', ')}\n`);

/** All XML under a mod dir, skipping asset-only folders. */
function xmlFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(Textures|Sounds|About|Languages|Source|obj|bin)$/i.test(e.name)) continue;
        stack.push(full);
      } else if (/\.xml$/i.test(e.name)) {
        try {
          if (fs.statSync(full).size < 400000) out.push(full);
        } catch {
          /* unreadable */
        }
      }
    }
  }
  return out;
}

/** Split top-level <li> children, respecting nesting. */
function items(block) {
  const out = [];
  const open = /<li(?:\s[^>]*)?>/g;
  let m;
  while ((m = open.exec(block)) !== null) {
    let depth = 1;
    const scan = /<li(?:\s[^>]*)?>|<\/li>/g;
    scan.lastIndex = m.index + m[0].length;
    let s;
    let end = -1;
    while ((s = scan.exec(block)) !== null) {
      if (s[0] === '</li>') {
        depth -= 1;
        if (depth === 0) {
          end = s.index;
          break;
        }
      } else depth += 1;
    }
    if (end === -1) break;
    out.push(block.slice(m.index + m[0].length, end));
    open.lastIndex = end;
  }
  return out;
}

/** Parse one tool block, whether it is a plain <li> or a ToolCE. */
function parseTool(t) {
  const capBlock = /<capacities>([\s\S]*?)<\/capacities>/.exec(t);
  return {
    isCE: /CombatExtended\.ToolCE/.test(t),
    label: (/<label>\s*([^<]*?)\s*<\/label>/.exec(t) ?? [])[1],
    capacities: capBlock
      ? [...capBlock[1].matchAll(/<li>\s*([^<\s]+)\s*<\/li>/g)].map((x) => x[1])
      : [],
    power: (/<power>\s*([\d.]+)\s*<\/power>/.exec(t) ?? [])[1],
    cooldownTime: (/<cooldownTime>\s*([\d.]+)\s*<\/cooldownTime>/.exec(t) ?? [])[1],
    chanceFactor: (/<chanceFactor>\s*([\d.]+)\s*<\/chanceFactor>/.exec(t) ?? [])[1],
    aps: (/<armorPenetrationSharp>\s*([\d.]+)\s*<\/armorPenetrationSharp>/.exec(t) ?? [])[1],
    apb: (/<armorPenetrationBlunt>\s*([\d.]+)\s*<\/armorPenetrationBlunt>/.exec(t) ?? [])[1],
  };
}

const hits = [];
let scanned = 0;

for (const mod of mods.active) {
  if (!mod.installed || !mod.dir) continue;
  scanned += 1;
  for (const file of xmlFiles(mod.dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    if (!keywords.some((k) => lower.includes(k))) continue;

    // Weapons: any ThingDef carrying tools.
    for (const m of text.matchAll(/<ThingDef\b([^>]*)>([\s\S]*?)<\/ThingDef>/g)) {
      const body = m[2];
      const defName = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(body) ?? [])[1];
      if (!defName) continue;
      const block = /<tools[^>]*>([\s\S]*?)<\/tools>/.exec(body);
      if (!block) continue;
      const nameHit = keywords.some((k) => defName.toLowerCase().includes(k)
        || String((/<label>\s*([^<]*?)\s*<\/label>/.exec(body) ?? [])[1] ?? '').toLowerCase().includes(k));
      if (!nameHit) continue;
      hits.push({
        mod: mod.name,
        packageId: mod.packageId,
        defName,
        label: (/<label>\s*([^<]*?)\s*<\/label>/.exec(body) ?? [])[1],
        file: path.relative(mod.dir, file),
        tools: items(block[1]).map(parseTool),
        ce: false,
      });
    }

    // CE conversions: PatchOperationReplace on a def's /tools, or a ToolCE list anywhere.
    if (/ToolCE/.test(text)) {
      for (const m of text.matchAll(/defName="([^"]+)"\]\s*\/tools/g)) {
        const defName = m[1];
        if (!keywords.some((k) => defName.toLowerCase().includes(k))) continue;
        // Take the tools block that follows.
        const after = text.slice(m.index);
        const block = /<tools[^>]*>([\s\S]*?)<\/tools>/.exec(after);
        if (!block) continue;
        const tools = items(block[1]).map(parseTool).filter((t) => t.isCE);
        if (tools.length === 0) continue;
        hits.push({
          mod: mod.name,
          packageId: mod.packageId,
          defName,
          label: '(CE patch)',
          file: path.relative(mod.dir, file),
          tools,
          ce: true,
        });
      }
    }
  }
}

console.log(`scanned ${scanned} mod directories\n`);

if (hits.length === 0) {
  console.log('no matching weapon found');
  process.exit(0);
}

for (const h of hits) {
  console.log(`${h.ce ? '★ CE 补丁' : '  本体  '}  ${h.defName}`);
  console.log(`    mod : ${h.mod}  [${h.packageId}]`);
  console.log(`    file: ${h.file}`);
  for (const t of h.tools) {
    console.log(`      ${(t.label ?? '?').padEnd(20)} ${t.capacities.join('+').padEnd(16)} `
      + `power=${String(t.power ?? '-').padEnd(5)} cd=${String(t.cooldownTime ?? '-').padEnd(5)} `
      + `chance=${String(t.chanceFactor ?? '-').padEnd(5)} APs=${String(t.aps ?? '-').padEnd(8)} APb=${t.apb ?? '-'}`);
  }
  console.log('');
}
