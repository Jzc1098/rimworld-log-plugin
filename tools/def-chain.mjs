/**
 * Walk a def's ParentName chain and print the crafting-relevant fields found at each level.
 *
 * These weapon defs inherit most of their cost and research gate from a template, and a def that
 * looks uncraftable on its own is often built through a recipe belonging to the parent or to a
 * module it attaches to. Printing the whole chain shows where the real gate lives.
 *
 * Usage: node def-chain.mjs <defName> [...]
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const wanted = process.argv.slice(2);
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

const defs = new Map();
const recipes = [];
for (const mod of mods.active) {
  if (!mod.installed || !mod.dir) continue;
  for (const file of xmlFiles(mod.dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(mod.dir, file);
    for (const m of text.matchAll(/<ThingDef\b([^>]*)>([\s\S]*?)<\/ThingDef>/g)) {
      const dn = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(m[2]) ?? [])[1];
      if (dn && !defs.has(dn)) {
        defs.set(dn, {
          defName: dn,
          parent: (/ParentName="([^"]+)"/.exec(m[1]) ?? [])[1],
          body: m[2],
          mod: mod.name,
          file: rel,
        });
      }
    }
    for (const m of text.matchAll(/<RecipeDef\b[^>]*>([\s\S]*?)<\/RecipeDef>/g)) {
      const dn = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(m[1]) ?? [])[1];
      recipes.push({ defName: dn, body: m[1], mod: mod.name, file: rel });
    }
  }
}

const one = (body, tag) => {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(body ?? '');
  return m ? m[1] : undefined;
};
const list = (body, container) => {
  const m = new RegExp(`<${container}>([\\s\\S]*?)</${container}>`).exec(body ?? '');
  if (!m) return [];
  return [...m[1].matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)].map((x) => x[1].trim());
};

for (const name of wanted) {
  console.log('='.repeat(86));
  console.log(`CHAIN: ${name}`);
  console.log('='.repeat(86));

  let cur = defs.get(name);
  const seen = new Set();
  let depth = 0;
  while (cur && !seen.has(cur.defName) && depth < 12) {
    seen.add(cur.defName);
    depth += 1;
    console.log(`\n  [${depth}] ${cur.defName}   (${cur.mod})`);
    console.log(`      file   : ${cur.file}`);
    console.log(`      parent : ${cur.parent ?? '(none)'}`);

    const rp = list(cur.body, 'researchPrerequisites');
    if (rp.length) console.log(`      科研前置: ${rp.join(', ')}`);

    const rm = /<recipeMaker>([\s\S]*?)<\/recipeMaker>/.exec(cur.body);
    if (rm) {
      const ing = [...rm[1].matchAll(/<([A-Za-z0-9_]+)>(\d+)<\/\1>/g)]
        .filter((x) => !['researchPrerequisite', 'workAmount'].includes(x[1]))
        .map((x) => `${x[1]}×${x[2]}`);
      console.log(`      recipeMaker: 研究=${one(rm[1], 'researchPrerequisite') ?? '—'} 工作=${one(rm[1], 'workAmount') ?? '—'}`);
      if (ing.length) console.log(`                   材料: ${ing.join('  ')}`);
    }

    const cl = [...cur.body.matchAll(/<costList>([\s\S]*?)<\/costList>/g)]
      .flatMap((m) => [...m[1].matchAll(/<([A-Za-z0-9_]+)>(\d+)<\/\1>/g)].map((x) => `${x[1]}×${x[2]}`));
    if (cl.length) console.log(`      costList : ${cl.join('  ')}`);

    const misc = ['MaxHitPoints', 'Mass', 'WorkToMake', 'MarketValue']
      .map((s) => (one(cur.body, s) ? `${s}=${one(cur.body, s)}` : undefined)).filter(Boolean);
    if (misc.length) console.log(`      属性   : ${misc.join('  ')}`);

    cur = cur.parent ? defs.get(cur.parent) : undefined;
  }

  // Recipes that produce this def, or that the def's own chain names.
  const making = recipes.filter((r) => new RegExp(`<${name}>\\d+</${name}>`).test(r.body));
  if (making.length) {
    console.log(`\n  可制作它的配方:`);
    for (const r of making) {
      const ing = [...r.body.matchAll(/<([A-Za-z0-9_]+)>(\d+)<\/\1>/g)].map((x) => `${x[1]}×${x[2]}`);
      console.log(`      ${r.defName}  (${r.mod})`);
      console.log(`          工作=${one(r.body, 'workAmount') ?? '—'}   材料: ${ing.join('  ') || '—'}`);
      const rp = list(r.body, 'researchPrerequisites');
      if (rp.length) console.log(`          科研: ${rp.join(', ')}`);
    }
  }
  console.log('');
}
