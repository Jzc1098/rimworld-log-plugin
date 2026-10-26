/**
 * Pull CE's melee ToolCE values for named weapons, so a mapping for an unpatched weapon can be
 * anchored to CE's own numbers instead of invented ones.
 *
 * Usage: node ce-melee-anchor.mjs <CE mod dir> [defName ...]
 *
 * Without def names it prints the vanilla melee weapons CE patches, which is the reference set.
 */

import fs from 'node:fs';
import path from 'node:path';

const ceDir = process.argv[2];
const wanted = process.argv.slice(3);
if (!ceDir) {
  console.error('usage: node ce-melee-anchor.mjs <CE mod dir> [defName ...]');
  process.exit(2);
}

/** All XML under a directory, skipping asset folders. */
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
        if (/^(Textures|Sounds|Languages|About|Source|Assemblies|obj|bin)$/i.test(e.name)) continue;
        stack.push(full);
      } else if (/\.xml$/i.test(e.name) && fs.statSync(full).size < 300000) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Split top-level <li> children of a block, respecting nesting. */
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

/** ToolCE entries in a file, with the ThingDef they belong to. */
function toolsIn(text) {
  const found = [];
  for (const m of text.matchAll(/<ThingDef\b[^>]*>([\s\S]*?)<\/ThingDef>/g)) {
    const body = m[1];
    const defName = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(body) ?? [])[1];
    if (!defName) continue;
    const block = /<tools[^>]*>([\s\S]*?)<\/tools>/.exec(body);
    if (!block) continue;
    for (const t of items(block[1])) {
      if (!/CombatExtended\.ToolCE/.test(t)) continue;
      const capBlock = /<capacities>([\s\S]*?)<\/capacities>/.exec(t);
      found.push({
        defName,
        label: (/<label>\s*([^<]*?)\s*<\/label>/.exec(t) ?? [])[1],
        capacities: capBlock ? [...capBlock[1].matchAll(/<li>\s*([^<\s]+)\s*<\/li>/g)].map((x) => x[1]) : [],
        power: (/<power>\s*([\d.]+)\s*<\/power>/.exec(t) ?? [])[1],
        cooldownTime: (/<cooldownTime>\s*([\d.]+)\s*<\/cooldownTime>/.exec(t) ?? [])[1],
        chanceFactor: (/<chanceFactor>\s*([\d.]+)\s*<\/chanceFactor>/.exec(t) ?? [])[1],
        aps: (/<armorPenetrationSharp>\s*([\d.]+)\s*<\/armorPenetrationSharp>/.exec(t) ?? [])[1],
        apb: (/<armorPenetrationBlunt>\s*([\d.]+)\s*<\/armorPenetrationBlunt>/.exec(t) ?? [])[1],
      });
    }
  }
  return found;
}

// The reference set: vanilla melee weapons CE itself patches.
const VANILLA_MELEE = [
  'MeleeWeapon_Knife', 'MeleeWeapon_LongSword', 'MeleeWeapon_Spear', 'MeleeWeapon_Mace',
  'MeleeWeapon_Gladius', 'MeleeWeapon_Axe', 'MeleeWeapon_Warhammer', 'MeleeWeapon_Club',
  'MeleeWeapon_ShortShield', 'MeleeWeapon_MonoSword', 'MeleeWeapon_PlasmaSword',
  'MeleeWeapon_Zeushammer', 'MeleeWeapon_MonoAxe', 'MeleeWeapon_PersonaZeushammer',
];

const files = xmlFiles(ceDir);
const targets = wanted.length > 0 ? wanted : VANILLA_MELEE;

const rows = [];
for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('ToolCE')) continue;
  for (const t of toolsIn(text)) {
    if (!targets.includes(t.defName)) continue;
    rows.push({ ...t, file: path.relative(ceDir, f) });
  }
}

console.log(`CE dir : ${ceDir}`);
console.log(`xml    : ${files.length} files scanned`);
console.log(`targets: ${targets.length} def names\n`);

const byDef = new Map();
for (const r of rows) {
  if (!byDef.has(r.defName)) byDef.set(r.defName, []);
  byDef.get(r.defName).push(r);
}

for (const name of targets) {
  const list = byDef.get(name);
  if (!list) {
    console.log(`=== ${name}   (CE does not patch it)`);
    continue;
  }
  console.log(`=== ${name}`);
  for (const t of list) {
    console.log(`    ${(t.label ?? '?').padEnd(14)} ${t.capacities.join('+').padEnd(12)} `
      + `power=${String(t.power ?? '-').padEnd(5)} cd=${String(t.cooldownTime ?? '-').padEnd(5)} `
      + `chance=${String(t.chanceFactor ?? '-').padEnd(5)} APs=${String(t.aps ?? '-').padEnd(8)} APb=${t.apb ?? '-'}`);
  }
  console.log(`    source: ${list[0].file}`);
}
