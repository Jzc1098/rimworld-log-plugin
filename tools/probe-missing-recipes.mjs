/**
 * Survey the three "found no recipe named X" cases so a plan can be written before any patch exists.
 *
 * For each missing recipe name:
 *   - does the recipe def exist anywhere on disk?
 *   - which ThingDef is the ammunition, what parent does it use, what crafting tags does it carry?
 *   - do sibling ammunition entries in the SAME file have recipes? (if yes, the mod simply forgot one)
 *
 * Usage: node probe-missing-recipes.mjs
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

const wanted = [
  { recipe: 'MakeShell_AntigrainWarhead', ammo: 'Shell_AntigrainWarhead', owner: "The Dead Man's Switch" },
  { recipe: 'MakeAmmo_RK_DragonAmmo_Normal', ammo: 'RK_DragonAmmo_Normal', owner: 'Ratkin CE Patch Collection' },
  { recipe: 'MakeAmmo_RK_DragonAmmo_Flame', ammo: 'RK_DragonAmmo_Flame', owner: 'Ratkin CE Patch Collection' },
  { recipe: 'MakeAmmo_155mmHowitzerShell_Anti', ammo: '155mmHowitzerShell_Anti', owner: 'Combat Extended + Fortifications - Industrial' },
];

/** Collect every xml file once, with its mod name. */
const files = [];
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
      } else if (e.name.toLowerCase().endsWith('.xml')) {
        files.push({ file: full, mod: name, modDir: dir });
      }
    }
  }
}
console.log(`xml files indexed: ${files.length}\n`);

/** Find the ThingDef / RecipeDef block declaring a given defName. */
function findDef(defName) {
  const hits = [];
  const needle = `<defName>${defName}</defName>`;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(needle)) continue;
    for (const m of text.matchAll(/<(ThingDef|RecipeDef|ThingCategoryDef|CombatExtended\.AmmoSetDef)\b.*?<\/\1>/gs)) {
      const block = m[0];
      if (!block.includes(needle)) continue;
      hits.push({ kind: m[1], block, mod: f.mod, file: f.file.replace(f.modDir, ''), modDir: f.modDir });
    }
  }
  return hits;
}

for (const w of wanted) {
  console.log('='.repeat(78));
  console.log(`${w.recipe}`);
  console.log(`  expected owner: ${w.owner}`);
  console.log('='.repeat(78));

  const recipeHits = findDef(w.recipe);
  console.log(`  recipe def found on disk: ${recipeHits.length === 0 ? 'NO - genuinely missing' : 'yes (' + recipeHits.length + ')'}`);
  for (const h of recipeHits) console.log(`      ${h.mod}  ${h.file}`);

  const ammoHits = findDef(w.ammo);
  console.log(`  ammunition def found on disk: ${ammoHits.length}`);
  for (const h of ammoHits) {
    const head = /<(ThingDef)\b[^>]*>/.exec(h.block)[0];
    const parent = /ParentName="([^"]+)"/.exec(head);
    const abs = /Abstract="True"/.test(head);
    const tags = [...h.block.matchAll(/<li>(CE_AutoEnableCrafting[A-Za-z_]*)<\/li>/g)].map((x) => x[1]);
    const rm = /<recipeMaker\b[^>]*>/.exec(h.block);
    const tex = /<texPath>\s*([^<\s]+)\s*<\/texPath>/.exec(h.block);
    console.log(`      ${h.mod}  ${h.file}`);
    console.log(`          head       ${head.trim()}`);
    console.log(`          abstract   ${abs}   parent=${parent ? parent[1] : '(none)'}`);
    console.log(`          craftTags  ${tags.length ? tags.join(', ') : '(none)'}`);
    console.log(`          texPath    ${tex ? tex[1] : '(none)'}`);
    if (rm) {
      const users = [...h.block.matchAll(/<recipeUsers>\s*([\s\S]*?)<\/recipeUsers>/g)].map((x) => x[1].replace(/\s+/g, ' ').trim());
      console.log(`          recipeMaker present; recipeUsers=${users.join(' | ') || '(inherited)'}`);
    }
  }
  console.log('');
}
