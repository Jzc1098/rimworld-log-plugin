/**
 * Report which active package ids were not resolved to a directory, and check whether any of
 * them exist somewhere obvious. Development aid for validating the mod search roots.
 *
 * Usage: node missing.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from './lib/detect.js';

const env = detectEnvironment();
if (!env.profile) {
  console.log('no profile');
  process.exit(0);
}
const mods = activeModList(env.profile, env.config);
const missing = mods.active.filter((m) => !m.installed);
console.log(`active=${mods.activeCount} missing=${missing.length}`);
console.log('search roots:');
for (const root of mods.searchRoots) {
  let count = 0;
  try {
    count = fs.readdirSync(root).length;
  } catch {
    count = -1;
  }
  console.log(`  ${count < 0 ? '(unreadable)' : `${count} entries`}  ${root}`);
}

console.log('\n-- missing package ids --');
for (const mod of missing) {
  console.log(`  ${mod.packageId}`);
}

// Independent check: does any About.xml on any readable workshop root declare one of them?
if (missing.length > 0 && missing.length <= 40) {
  const needles = new Set(missing.map((m) => m.packageId.toLowerCase()));
  const found = new Map();
  for (const root of mods.searchRoots) {
    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const child of children) {
      const about = path.join(root, child.name, 'About', 'About.xml');
      let xml;
      try {
        xml = fs.readFileSync(about, 'utf8');
      } catch {
        continue;
      }
      const stripped = xml.replace(/<(modDependencies|loadAfter|loadBefore|incompatibleWith)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
      const match = /<packageId\b[^>]*>([^<]*)<\/packageId\s*>/i.exec(stripped);
      const id = match ? match[1].trim().toLowerCase() : '';
      if (id && needles.has(id) && !found.has(id)) found.set(id, path.join(root, child.name));
    }
  }
  console.log('\n-- present on disk anyway? --');
  for (const id of needles) {
    console.log(`  ${found.has(id) ? `FOUND ${found.get(id)}` : 'absent'}  ${id}`);
  }
}
