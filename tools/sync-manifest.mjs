/**
 * Regenerate the file list in `插件清单.md` from what is actually in the plugin directory.
 *
 * Why a script: that document is a hand-written inventory, and this project has already shipped a
 * manifest claiming 55 files while the directory held 83. The list of `tools/` entries is therefore
 * derived from the filesystem here. The prose around it (who each document is for, what it covers) is
 * left alone - it cannot be derived, and overwriting it would lose information.
 *
 * Idempotent: running it twice produces the same file.
 *
 * Usage: node tools/sync-manifest.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, '插件清单.md');

const CN = /[\u4e00-\u9fff]/;

/** Markdown table cells cannot hold a raw pipe; the document avoids them rather than escaping. */
function cell(text) {
  return text.replace(/\|/g, '／').trim();
}

function sizeOf(file) {
  return `${fs.statSync(file).size.toLocaleString('en-US')} B`;
}

const toolsDir = path.join(root, 'tools');

/**
 * Every file under `tools/`, recursively, as paths relative to the plugin root.
 *
 * Recursion is not a nicety here. The first version used `readdirSync` with an `isFile()` filter, which
 * sees only the top level - so the six files in `tools/dev/` (`diag.mjs`, `debug-*.mjs`, `missing.mjs`)
 * silently vanished from the inventory while the heading counted 70 instead of 76. A manifest that quietly
 * omits files is worse than no manifest: it is the exact drift this script exists to prevent, produced by
 * the script itself.
 */
function walkTools(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Bytecode is produced by *running* a Python tool, not by shipping one. Counting it makes the
    // inventory depend on whether someone happened to run a script before generating the manifest —
    // the heading then drifts by the number of cached files (observed: 76 → 78 after one py_compile).
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') continue;
      out.push(...walkTools(full));
    } else if (entry.isFile()) {
      if (/\.py[co]$/i.test(entry.name)) continue;
      if (["write-plugin-manifest.py", "lib_tools.py", "tools.json"].includes(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const toolPaths = walkTools(toolsDir)
  .map((full) => path.relative(root, full).split(path.sep).join('/'))
  .sort((a, b) => a.localeCompare(b, 'en'));

const toolFiles = toolPaths;

const original = fs.readFileSync(manifest, 'utf8');
const lines = original.split('\n');

// ---- 1. section 五 heading: the count ------------------------------------
const toolsHeading = lines.findIndex((l) => l.startsWith('## 五、调查工具'));
if (toolsHeading < 0) {
  console.error('section 五 not found; refusing to guess');
  process.exit(1);
}
const oldHeading = lines[toolsHeading];
const newHeading = oldHeading.replace(/\d+ 个/, `${toolFiles.length} 个`);
if (oldHeading !== newHeading) lines[toolsHeading] = newHeading;

// ---- 2. section 五 list: regenerate inside <details> ---------------------
const open = lines.findIndex((l, i) => i > toolsHeading && l.trim() === '<details>');
const close = lines.findIndex((l, i) => i > open && l.trim() === '</details>');
if (open < 0 || close < 0) {
  console.error('details block not found in section 五');
  process.exit(1);
}

const body = [
  '<details>',
  '<summary>展开文件列表</summary>',
  '',
  ...toolPaths.map((rel) => `- \`${rel}\`  (${sizeOf(path.join(root, rel))})`),
  '',
  '</details>',
];
lines.splice(open, close - open + 1, ...body);

const next = lines.join('\n');
const changed = next !== original;
console.log(`tools/ 实际文件数 : ${toolFiles.length}`);
console.log(`标题              : ${oldHeading.replace(/^## /, '')}`);
console.log(`                 -> ${(lines[toolsHeading]).replace(/^## /, '')}`);
console.log(`列表条目          : ${toolFiles.length}`);
console.log(changed ? '文件有变化' : '文件无变化（已是最新）');

if (dryRun) {
  console.log('\ndry run: nothing written');
  process.exit(0);
}
if (changed) {
  fs.writeFileSync(manifest, next, 'utf8');
  console.log(`written: ${manifest}`);
}
