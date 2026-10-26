/**
 * Node port of tools/bump-version.py.
 *
 * The Python script could not run here - this machine has only the Windows Store `python.exe`
 * placeholder, which exits 9009. The logic below is deliberately a line-for-line port rather than a
 * "close enough" rewrite, because it edits two files that other tooling reads:
 * `package.json` (the declared version) and `blocks.json` (every block's sub-version).
 *
 * Three things move together:
 *   1. package.json `version`
 *   2. every `version` / `modifiedVersion` in blocks.json whose base is the old version
 *   3. registry entries whose file is gone (or is a backup that should never have been registered)
 *
 * Usage: node tools/bump-version.mjs <x.y.z> [--dry-run] [--plugin DIR]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_NAME = /\.(bak|tmp|orig|old|swp)$|~$|\.pre-[a-z]+\.bak$/i;

const argv = process.argv.slice(2);
const version = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
const pluginFlag = argv.indexOf('--plugin');
const plugin = pluginFlag >= 0 && argv[pluginFlag + 1]
  ? path.resolve(argv[pluginFlag + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('version must look like 1.2.0');
  process.exit(2);
}

const pkgPath = path.join(plugin, 'package.json');
const regPath = path.join(plugin, 'blocks.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = String(pkg.version ?? '');
if (oldVersion === version) console.log(`package.json is already at ${version}`);

const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
const blocks = registry.blocks ?? [];

// ---- 1. versions ----------------------------------------------------------
const versionRe = new RegExp(`^${oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\..*)?$`);
let versionHits = 0;
for (const block of blocks) {
  for (const field of ['version', 'modifiedVersion']) {
    const value = block[field];
    if (typeof value !== 'string') continue;
    const match = versionRe.exec(value);
    if (!match) continue;
    block[field] = version + (match[1] ?? '');
    versionHits++;
  }
}

// ---- 2. entries whose file is gone ---------------------------------------
const survivors = [];
const dropped = new Map();
for (const block of blocks) {
  const rel = block.path ?? block.file ?? String(block.id ?? '').split(':')[0];
  const base = path.basename(rel);
  const missing = !fs.existsSync(path.join(plugin, rel));
  if (missing || SKIP_NAME.test(base)) {
    dropped.set(rel, (dropped.get(rel) ?? 0) + 1);
    continue;
  }
  survivors.push(block);
}

console.log(`plugin        : ${plugin}`);
console.log(`version       : ${oldVersion} -> ${version}`);
console.log(`version fields: ${versionHits}`);
console.log(`blocks        : ${blocks.length} -> ${survivors.length}`);
console.log('');
if (dropped.size) {
  console.log('registry entries removed (file gone, or a backup that should never have been registered):');
  for (const [rel, count] of [...dropped.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rel}  ->  ${count} block(s)`);
  }
} else {
  console.log('registry entries removed: none');
}

if (dryRun) {
  console.log('\ndry run: nothing written');
  process.exit(0);
}

pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
registry.blocks = survivors;
registry.pluginVersion = version;
fs.writeFileSync(regPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');

console.log('\nwritten: package.json, blocks.json');
