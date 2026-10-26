// Find which enabled mod defines a def with a given defName or label.
//
// Written to locate `巨灵运输舱`, which VRF's debug log names as a vehicle but which is not in the DMS
// Legion mod that owns the other vehicles in the same raid. Two whole-disk recursive searches had
// already timed out, so this walks only the mod directories the plugin already indexed and stops at
// the first hit per mod.
//
// Usage: node find-def-across-mods.mjs <needle> [--all]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (n) => pathToFileURL(path.join(pluginRoot, 'lib', n)).href;
const detect = await import(lib('detect.js'));

const needle = process.argv[2];
const showAll = process.argv.includes('--all');
if (!needle) {
  console.error('usage: node find-def-across-mods.mjs <needle> [--all]');
  process.exit(2);
}

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, {
  toolModRoots: [path.join(env.home ?? '', 'toolmods')],
});
const roots = modlist.modRoots ?? [];
console.log('indexed mod dirs: ' + roots.length + '   needle: ' + needle);

const hits = [];
for (const entry of roots) {
  const dir = entry.root;
  if (!dir || !fs.existsSync(dir)) continue;
  let found = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (/^(Textures|Sounds|\.git|obj|Source|Assemblies)$/i.test(e.name)) continue;
        stack.push(full);
        continue;
      }
      if (!/\.xml$/i.test(e.name)) continue;
      let text;
      try {
        if (fs.statSync(full).size > 3 * 1024 * 1024) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes(needle)) continue;
      found++;
      hits.push({
        pkg: entry.packageId || '(no packageId)',
        name: entry.name || '',
        file: path.relative(dir, full),
        dir,
      });
      if (!showAll) break;
    }
    if (found && !showAll) break;
  }
}

console.log('');
console.log('mods containing the needle: ' + new Set(hits.map((h) => h.pkg)).size);
const seen = new Set();
for (const h of hits) {
  const key = h.pkg + '|' + h.file;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log('  [' + h.pkg + ']  ' + h.name);
  console.log('     ' + h.dir);
  console.log('     ' + h.file);
}
