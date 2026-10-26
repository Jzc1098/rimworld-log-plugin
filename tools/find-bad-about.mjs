/**
 * Find every About.xml that lacks a packageId, recursively.
 *
 * RimWorld warns "Mod <folder> is missing packageId in About.xml" for each one, and a mod whose
 * About.xml fails to deserialise produces the same warning plus a parse exception. Those warnings
 * name the folder by its numeric workshop id, so the offending file is not the one in the workshop
 * copy - it is a second copy somewhere else on disk.
 *
 * Usage: node find-bad-about.mjs <root> [<root> ...]
 */

import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node find-bad-about.mjs <root> [<root> ...]');
  process.exit(2);
}

let scanned = 0;
const bad = [];

function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // An About folder marks a mod root; do not descend further into it.
  if (entries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'about')) {
    const about = path.join(dir, 'About', 'About.xml');
    if (fs.existsSync(about)) {
      scanned += 1;
      let text;
      try {
        text = fs.readFileSync(about, 'utf8');
      } catch {
        bad.push({ file: about, why: 'unreadable' });
        return;
      }
      const hasPkg = /<packageId\s*>/i.test(text);
      const hasVer = /<supportedVersions\s*>/i.test(text);
      if (!hasPkg || !hasVer) {
        const name = (/<name>([^<]*)<\/name>/.exec(text) ?? [])[1] ?? '(no name)';
        bad.push({ file: about, folder: path.basename(dir), name, hasPkg, hasVer, bytes: text.length });
      }
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/^(Textures|Sounds|Languages|Defs|Patches|Assemblies|Source|obj|bin|\.git)$/i.test(e.name)) continue;
    walk(path.join(dir, e.name), depth + 1);
  }
}

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  walk(root, 0);
}

console.log(`scanned ${scanned} About.xml files\n`);
console.log(`=== missing packageId or supportedVersions: ${bad.length} ===`);
for (const b of bad) {
  if (b.why) {
    console.log(`  ${b.file}  (${b.why})`);
    continue;
  }
  console.log(`  folder=${b.folder}  name="${b.name}"  packageId=${b.hasPkg}  supportedVersions=${b.hasVer}  ${b.bytes}B`);
  console.log(`      ${b.file}`);
}
