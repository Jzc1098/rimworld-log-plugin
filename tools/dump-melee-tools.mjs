/**
 * List every melee weapon def in a mod with its tools, and resolve each tool capacity to the
 * DamageDef that provides it.
 *
 * The point is to see a weapon's real damage profile, including capacities that are not vanilla.
 * A capacity like `WG_HeavySweep` names a DamageDef the weapon's own mod introduces; that has to be
 * known before mapping the weapon into another combat system, because the new system may not have it.
 *
 * Usage: node dump-melee-tools.mjs <modDir>
 */

import fs from 'node:fs';
import path from 'node:path';

const modDir = process.argv[2];
if (!modDir) {
  console.error('usage: node dump-melee-tools.mjs <modDir>');
  process.exit(2);
}

/**
 * Split a block of `<li>...</li>` children, respecting nesting.
 *
 * A tool's own `<li>` contains another `<li>` for each capacity, so a non-greedy regex match returns
 * only the opening fragment. Depth counting is the only reliable way to get whole items.
 *
 * @param {string} block - the inner text of a container element.
 * @returns {string[]} each top-level item's inner text.
 */
function topLevelItems(block) {
  const out = [];
  const open = /<li(?:\s[^>]*)?>/g;
  let m;
  while ((m = open.exec(block)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const scan = /<li(?:\s[^>]*)?>|<\/li>/g;
    scan.lastIndex = i;
    let s;
    let end = -1;
    while ((s = scan.exec(block)) !== null) {
      if (s[0] === '</li>') {
        depth -= 1;
        if (depth === 0) {
          end = s.index;
          break;
        }
      } else {
        depth += 1;
      }
    }
    if (end === -1) break;
    out.push(block.slice(i, end));
    open.lastIndex = end;
  }
  return out;
}

/** Every XML file under the mod, skipping asset folders. */
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
      } else if (/\.xml$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** DamageDefs defined anywhere in the mod, keyed by defName. */
function damageDefs(files) {
  const map = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/<DamageDef>([\s\S]*?)<\/DamageDef>/g)) {
      const body = m[1];
      const name = /<defName>\s*([^<\s]+)\s*<\/defName>/.exec(body);
      if (!name) continue;
      map.set(name[1], {
        defName: name[1],
        armorCategory: (/<armorCategory>\s*([^<\s]+)\s*<\/armorCategory>/.exec(body) ?? [])[1],
        file: path.relative(modDir, f),
      });
    }
  }
  return map;
}

/** ThingDefs that carry at least one tool, i.e. melee weapons. */
function meleeWeapons(files) {
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/<ThingDef\b([^>]*)>([\s\S]*?)<\/ThingDef>/g)) {
      const attrs = m[1];
      const body = m[2];
      const defName = /<defName>\s*([^<\s]+)\s*<\/defName>/.exec(body);
      if (!defName) continue;
      const toolsBlock = /<tools>([\s\S]*?)<\/tools>/.exec(body);
      if (!toolsBlock) continue;

      // Tools are <li> blocks that themselves contain <li> for capacities, so a naive non-greedy
      // match stops at the first nested </li> and the block comes back half-parsed. Track depth
      // instead of relying on the shape.
      const tools = [];
      for (const t of topLevelItems(toolsBlock[1])) {
        const label = (/<label>\s*([^<]*?)\s*<\/label>/.exec(t) ?? [])[1];
        const capBlock = /<capacities>([\s\S]*?)<\/capacities>/.exec(t);
        const capacities = capBlock
          ? [...capBlock[1].matchAll(/<li>\s*([^<\s]+)\s*<\/li>/g)].map((x) => x[1])
          : [];
        tools.push({
          label,
          capacities,
          power: (/<power>\s*([\d.]+)\s*<\/power>/.exec(t) ?? [])[1],
          armorPenetration: (/<armorPenetration>\s*([\d.]+)\s*<\/armorPenetration>/.exec(t) ?? [])[1],
          cooldownTime: (/<cooldownTime>\s*([\d.]+)\s*<\/cooldownTime>/.exec(t) ?? [])[1],
          chanceFactor: (/<chanceFactor>\s*([\d.]+)\s*<\/chanceFactor>/.exec(t) ?? [])[1],
        });
      }
      out.push({
        defName: defName[1],
        parent: (/ParentName="([^"]+)"/.exec(attrs) ?? [])[1],
        file: path.relative(modDir, f),
        tools,
      });
    }
  }
  return out;
}

const files = xmlFiles(modDir);
console.log(`mod   : ${modDir}`);
console.log(`xml   : ${files.length} files\n`);

const damage = damageDefs(files);
console.log('=== DamageDefs defined by this mod ===');
if (damage.size === 0) console.log('  (none)');
for (const d of damage.values()) {
  console.log(`  ${d.defName.padEnd(22)} armorCategory=${d.armorCategory ?? '?'}   ${d.file}`);
}

console.log('\n=== melee weapons and their tools ===');
for (const w of meleeWeapons(files)) {
  console.log(`\n  ${w.defName}   (ParentName=${w.parent || 'none'})`);
  console.log(`      ${w.file}`);
  for (const t of w.tools) {
    const cap = t.capacities
      .map((c) => (damage.has(c) ? `${c}[本mod定义]` : c))
      .join(', ');
    console.log(`      tool "${t.label ?? '?'}"  capacity=${cap}`);
    console.log(`          power=${t.power ?? '-'}  ap=${t.armorPenetration ?? '-'}  `
      + `cooldown=${t.cooldownTime ?? '-'}  chance=${t.chanceFactor ?? '-'}`);
  }
}
