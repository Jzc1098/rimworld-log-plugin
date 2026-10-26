/**
 * Side-by-side parameter comparison for two melee weapon defs.
 *
 * Answers "which of these hits harder and why" by putting every field that affects damage output on
 * one line: per-hit power, cooldown, the chanceFactor that decides how often each tool is picked, the
 * number of tools competing, and any equipped stat offsets the weapon grants.
 *
 * Usage: node compare-weapons.mjs <defNameA> <defNameB>
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node compare-weapons.mjs <defNameA> <defNameB>');
  process.exit(2);
}

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, {
  toolModRoots: env.home ? [path.join(env.home, 'toolmods')] : [],
});

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

// Index relevant defs across enabled mods.
const defs = new Map();
for (const mod of mods.active) {
  if (!mod.installed || !mod.dir) continue;
  for (const file of xmlFiles(mod.dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/<ThingDef\b([^>]*)>([\s\S]*?)<\/ThingDef>/g)) {
      const dn = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(m[2]) ?? [])[1];
      if (dn && !defs.has(dn)) {
        defs.set(dn, {
          defName: dn,
          parent: (/ParentName="([^"]+)"/.exec(m[1]) ?? [])[1],
          body: m[2],
          mod: mod.name,
          file: path.relative(mod.dir, file),
        });
      }
    }
  }
}

function describe(defName) {
  const d = defs.get(defName);
  if (!d) return { defName, missing: true };

  const block = /<tools[^>]*>([\s\S]*?)<\/tools>/.exec(d.body);
  const tools = block
    ? items(block[1]).map((t) => {
        const cap = /<capacities>([\s\S]*?)<\/capacities>/.exec(t);
        return {
          label: (/<label>\s*([^<]*?)\s*<\/label>/.exec(t) ?? [])[1],
          capacities: cap ? [...cap[1].matchAll(/<li>\s*([^<\s]+)\s*<\/li>/g)].map((x) => x[1]) : [],
          power: Number((/<power>\s*([\d.]+)\s*<\/power>/.exec(t) ?? [])[1] ?? 0),
          cooldownTime: Number((/<cooldownTime>\s*([\d.]+)\s*<\/cooldownTime>/.exec(t) ?? [])[1] ?? 1),
          chanceFactor: Number((/<chanceFactor>\s*([\d.]+)\s*<\/chanceFactor>/.exec(t) ?? [])[1] ?? 1),
          armorPenetration: (/<armorPenetration>\s*([\d.]+)\s*<\/armorPenetration>/.exec(t) ?? [])[1],
        };
      })
    : [];

  const offsets = /<equippedStatOffsets>([\s\S]*?)<\/equippedStatOffsets>/.exec(d.body);
  return {
    defName,
    mod: d.mod,
    file: d.file,
    label: (/<label>\s*([^<]*?)\s*<\/label>/.exec(d.body) ?? [])[1],
    tools,
    offsets: offsets
      ? [...offsets[1].matchAll(/<([A-Za-z0-9_]+)>([-\d.]+)<\/\1>/g)].map((x) => `${x[1]}=${x[2]}`)
      : [],
    sweepComp: /CompProperties_MeleeSweep/.test(d.body)
      ? {
          damage: (/<damage>\s*([\d.]+)\s*<\/damage>/.exec(d.body) ?? [])[1],
          radius: (/<radius>\s*([\d.]+)\s*<\/radius>/.exec(d.body) ?? [])[1],
          angle: (/<angle>\s*([\d.]+)\s*<\/angle>/.exec(d.body) ?? [])[1],
        }
      : undefined,
  };
}

const A = describe(a);
const B = describe(b);

for (const w of [A, B]) {
  console.log('='.repeat(80));
  if (w.missing) {
    console.log(`${w.defName}  (not found)`);
    continue;
  }
  console.log(`${w.defName}   ${w.label ?? ''}`);
  console.log(`    mod: ${w.mod}   file: ${w.file}`);
  console.log(`    装备加成: ${w.offsets.length ? w.offsets.join('  ') : '(无)'}`);
  if (w.sweepComp) {
    console.log(`    范围攻击组件: 伤害=${w.sweepComp.damage} 半径=${w.sweepComp.radius} 角度=${w.sweepComp.angle}`);
  }
  const totalChance = w.tools.reduce((s, t) => s + t.chanceFactor, 0);
  for (const t of w.tools) {
    const share = totalChance > 0 ? t.chanceFactor / totalChance : 0;
    console.log(`    工具 "${t.label}"  ${t.capacities.join('+')}`);
    console.log(`        威力=${t.power}  冷却=${t.cooldownTime}s  概率权重=${t.chanceFactor}`
      + `  → 被选中概率 ${(share * 100).toFixed(1)}%`);
    console.log(`        该工具的期望 DPS ≈ ${(t.power * share / t.cooldownTime).toFixed(2)}`);
  }
  const dps = w.tools.reduce((s, t) => {
    const share = totalChance > 0 ? t.chanceFactor / totalChance : 0;
    return s + (t.power * share) / t.cooldownTime;
  }, 0);
  const perHit = w.tools.reduce((s, t) => {
    const share = totalChance > 0 ? t.chanceFactor / totalChance : 0;
    return s + t.power * share;
  }, 0);
  console.log(`    ─────────────────────────────`);
  console.log(`    单次命中期望伤害 ≈ ${perHit.toFixed(2)}`);
  console.log(`    持续输出期望 ≈ ${dps.toFixed(2)} /秒`);
  console.log('');
}
