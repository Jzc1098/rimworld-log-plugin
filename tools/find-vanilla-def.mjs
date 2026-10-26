/**
 * Check whether a def name is defined by the game itself, and if so where.
 *
 * The search covers the base game's Data folder and every installed DLC, because the Core folder
 * alone is not the whole vanilla surface, and reports the defining file so the answer is checkable.
 *
 * Usage: node find-vanilla-def.mjs <defName> [<defName> ...]
 */

import fs from 'node:fs';
import path from 'node:path';

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('usage: node find-vanilla-def.mjs <defName> [<defName> ...]');
  process.exit(2);
}

// 原版 Data 目录（RIMWORLD_DIR 指向游戏安装根；公开版不写死本机路径）
const gameData = process.env.RIMWORLD_DIR ? path.join(process.env.RIMWORLD_DIR, 'Data') : undefined;
if (!gameData) {
  console.error('请设置 RIMWORLD_DIR（RimWorld 安装根目录，其下应有 Data/ 与 Mods/）');
  process.exit(2);
}
if (!fs.existsSync(gameData)) {
  console.error(`game Data folder not found: ${gameData}`);
  process.exit(1);
}

const packs = fs.readdirSync(gameData, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
console.log(`game data packs: ${packs.join(', ')}\n`);

const hits = new Map(names.map((n) => [n, []]));
// Fields that mean "this def exists" versus "someone points at it".
const defineRe = (n) => new RegExp(`<defName>\\s*${n}\\s*</defName>`);

let files = 0;
const stack = [gameData];
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
      // Defs live in XML; textures and sounds cannot define one.
      if (/^(Textures|Sounds|About|Languages|Source)$/i.test(entry.name)) continue;
      stack.push(full);
      continue;
    }
    if (!/\.xml$/i.test(entry.name)) continue;
    files += 1;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const name of names) {
      if (!text.includes(name)) continue;
      hits.get(name).push({
        pack: path.relative(gameData, full).split(path.sep)[0],
        file: path.relative(gameData, full),
        defines: defineRe(name).test(text),
      });
    }
  }
}

console.log(`scanned ${files} xml files under ${gameData}\n`);
for (const name of names) {
  const list = hits.get(name);
  console.log(`=== ${name}  (${list.length} file(s)) ===`);
  if (list.length === 0) {
    console.log('  ▸ 原版（含 DLC）里完全没有这个名字');
    continue;
  }
  const definers = list.filter((h) => h.defines);
  if (definers.length > 0) {
    console.log('  ▸ 原版定义它的位置:');
    for (const h of definers) console.log(`      [${h.pack}] ${h.file}`);
  } else {
    console.log('  ▸ 名字出现了，但没有任何一处是 <defName> 定义 —— 原版也没有它');
    console.log('      只是被引用的位置:');
    for (const h of list.slice(0, 5)) console.log(`      [${h.pack}] ${h.file}`);
  }
  console.log('');
}
