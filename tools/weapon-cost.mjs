/**
 * Report the research gate and crafting cost of named weapon defs, following ParentName.
 *
 * Cost and research tier are what justify a weapon's power, so a balance decision needs them next to
 * the tool numbers. ParentName matters because most of these values are inherited rather than
 * written on the def itself, and reading only the child def would report "no cost" for a weapon that
 * is in fact gated behind expensive research.
 *
 * Usage: node weapon-cost.mjs <defName> [...]
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const wanted = process.argv.slice(2);
if (wanted.length === 0) {
  console.error('usage: node weapon-cost.mjs <defName> [...]');
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

// Index every ThingDef and RecipeDef by defName, recording where it came from.
const thingDefs = new Map();
const recipes = new Map();

for (const mod of mods.active) {
  if (!mod.installed || !mod.dir) continue;
  for (const file of xmlFiles(mod.dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/<ThingDef|<RecipeDef/.test(text)) continue;
    const rel = path.relative(mod.dir, file);

    for (const m of text.matchAll(/<ThingDef\b([^>]*)>([\s\S]*?)<\/ThingDef>/g)) {
      const body = m[2];
      const defName = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(body) ?? [])[1];
      if (!defName) continue;
      if (!thingDefs.has(defName)) {
        thingDefs.set(defName, {
          defName,
          parent: (/ParentName="([^"]+)"/.exec(m[1]) ?? [])[1],
          body,
          mod: mod.name,
          packageId: mod.packageId,
          file: rel,
        });
      }
    }

    for (const m of text.matchAll(/<RecipeDef\b([^>]*)>([\s\S]*?)<\/RecipeDef>/g)) {
      const body = m[2];
      const defName = (/<defName>\s*([^<\s]+)\s*<\/defName>/.exec(body) ?? [])[1];
      if (!defName) continue;
      recipes.set(defName, { defName, body, mod: mod.name, file: rel });
    }
  }
}

/** First capture of a tag inside a body, or undefined. */
const grab = (body, tag) => {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(body ?? '');
  return m ? m[1] : undefined;
};

/** The <li> values inside a named container. */
const listOf = (body, container) => {
  const m = new RegExp(`<${container}>([\\s\\S]*?)</${container}>`).exec(body ?? '');
  if (!m) return [];
  return [...m[1].matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)].map((x) => x[1].trim());
};

/** Walk ParentName up to a def whose body provides the tag. */
function inherited(defName, tag) {
  const seen = new Set();
  let cur = thingDefs.get(defName);
  const chain = [];
  while (cur && !seen.has(cur.defName)) {
    seen.add(cur.defName);
    const v = grab(cur.body, tag);
    chain.push(`${cur.defName}${v !== undefined ? ' ✓' : ''}`);
    if (v !== undefined) return { value: v, from: cur.defName, chain };
    cur = cur.parent ? thingDefs.get(cur.parent) : undefined;
  }
  return { value: undefined, from: undefined, chain };
}

console.log(`mods indexed: ${thingDefs.size} ThingDefs, ${recipes.size} RecipeDefs\n`);

for (const name of wanted) {
  const def = thingDefs.get(name);
  console.log('='.repeat(84));
  console.log(name);
  console.log('='.repeat(84));
  if (!def) {
    console.log('  (def not found in any enabled mod)');
    console.log('');
    continue;
  }
  console.log(`  mod      : ${def.mod}  [${def.packageId}]`);
  console.log(`  file     : ${def.file}`);
  console.log(`  parent   : ${def.parent ?? '(none)'}`);

  // Research gate, following inheritance.
  const rp = inherited(name, 'researchPrerequisites');
  const own = listOf(def.body, 'researchPrerequisites');
  const chainRp = rp.from ? listOf(thingDefs.get(rp.from)?.body, 'researchPrerequisites') : [];
  console.log(`  科研前置 : ${own.length ? own.join(', ') : '(def 自身未写)'}`);
  if (!own.length && rp.from) {
    console.log(`             ← 继承自 ${rp.from}: ${chainRp.length ? chainRp.join(', ') : '(也是空的)'}`);
  }

  // Recipe-based gating.
  const recipeMaker = /<recipeMaker>([\s\S]*?)<\/recipeMaker>/.exec(def.body);
  if (recipeMaker) {
    const rb = recipeMaker[1];
    console.log(`  recipeMaker:`);
    console.log(`      研究(${grab(rb, 'researchPrerequisite') ?? '—'})  工作${grab(rb, 'workAmount') ?? '—'}`);
    const ing = [...rb.matchAll(/<([A-Za-z0-9_]+)>(\d+)<\/\1>/g)]
      .filter((x) => !['researchPrerequisite', 'workAmount'].includes(x[1]))
      .map((x) => `${x[1]}×${x[2]}`);
    console.log(`      材料: ${ing.length ? ing.join('  ') : '—'}`);
  } else {
    console.log('  recipeMaker: (无 — 该 def 不直接制作)');
  }

  // costList / smelt / butcher anywhere on the def.
  const costs = [...def.body.matchAll(/<costList>([\s\S]*?)<\/costList>/g)]
    .flatMap((m) => [...m[1].matchAll(/<([A-Za-z0-9_]+)>(\d+)<\/\1>/g)].map((x) => `${x[1]}×${x[2]}`));
  if (costs.length) console.log(`  costList : ${costs.join('  ')}`);

  const stat = ['MaxHitPoints', 'Mass', 'WorkToMake'];
  const stats = stat.map((s) => {
    const v = grab(def.body, s);
    return v ? `${s}=${v}` : undefined;
  }).filter(Boolean);
  if (stats.length) console.log(`  自带属性 : ${stats.join('  ')}`);

  // Any recipe whose products include this def.
  const related = [...recipes.values()].filter((r) => r.body.includes(name));
  if (related.length) {
    console.log(`  相关配方 : ${related.map((r) => r.defName).join(', ')}`);
  }
  console.log('');
}
