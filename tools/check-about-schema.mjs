/**
 * Check every About.xml against the vanilla ModMetaData schema and report structural anomalies.
 *
 * The game logs "Exception loading from System.Xml.XmlElement: MissingMethodException: Default
 * constructor not found for type System.String" while reading mod metadata. That happens when the
 * deserialiser meets a shape it cannot map, so the useful question is not "which mod is broken" but
 * "which element is shaped wrong". This lists every element a file contains that ModMetaData does not
 * know, and every known container whose children are not shaped the way the schema expects.
 *
 * Usage: node check-about-schema.mjs <root> [<root> ...]
 */

import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);

// Verse.ModMetaData fields, as seen in vanilla About.xml and mods that load correctly.
const SCALAR = new Set([
  'name', 'author', 'description', 'packageId', 'modVersion', 'url', 'steamAppId',
]);
// Containers of plain strings, written as <li>text</li>.
const STRING_LIST = new Set([
  'supportedVersions', 'loadAfter', 'loadBefore', 'forceLoadAfter', 'forceLoadBefore',
  'incompatibleWith', 'descriptions', 'authors',
]);
// Containers of <li> structs.
const STRUCT_LIST = new Set(['modDependencies', 'modDependenciesByVersion']);

const anomalies = [];
let scanned = 0;

function walk(dir, depth) {
  if (depth > 5) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'about')) {
    const about = path.join(dir, 'About', 'About.xml');
    if (fs.existsSync(about)) {
      scanned += 1;
      let text;
      try {
        text = fs.readFileSync(about, 'utf8');
      } catch {
        return;
      }
      check(about, text);
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/^(Textures|Sounds|Languages|Defs|Patches|Assemblies|Source|obj|bin|\.git|News|Preview)$/i.test(e.name)) continue;
    walk(path.join(dir, e.name), depth + 1);
  }
}

function check(file, text) {
  // Lightweight: pull top-level element names, then inspect the interesting containers.
  const body = /<ModMetaData[^>]*>([\s\S]*)<\/ModMetaData>/i.exec(text);
  if (!body) {
    anomalies.push({ file, why: 'no <ModMetaData> root' });
    return;
  }
  const inner = body[1];

  // Top-level element names.
  const names = [];
  for (const m of inner.matchAll(/<([A-Za-z_][A-Za-z0-9_.-]*)\s*\/?>/g)) names.push(m[1]);
  const unknown = [...new Set(names)].filter((n) => !SCALAR.has(n) && !STRING_LIST.has(n) && !STRUCT_LIST.has(n));
  if (unknown.length) {
    anomalies.push({ file, why: `unknown top-level element(s): ${unknown.join(', ')}` });
  }

  // String lists must contain only text <li>.
  for (const tag of STRING_LIST) {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(inner);
    if (!m) continue;
    for (const li of m[1].matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)) {
      if (/<[A-Za-z_]/.test(li[1])) {
        anomalies.push({ file, why: `<${tag}> contains a nested element instead of text: ${li[1].trim().slice(0, 90)}` });
      }
    }
  }

  // Dependency lists must contain structs with packageId.
  for (const tag of STRUCT_LIST) {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(inner);
    if (!m) continue;
    for (const li of m[1].matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)) {
      if (!/<packageId/.test(li[1])) {
        anomalies.push({ file, why: `<${tag}> item without <packageId>: ${li[1].trim().slice(0, 90)}` });
      }
    }
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root, 0);
}

console.log(`scanned ${scanned} About.xml files`);
console.log(`\n=== structural anomalies: ${anomalies.length} ===`);
for (const a of anomalies) {
  console.log(`  ${a.why}`);
  console.log(`      ${a.file}`);
}
