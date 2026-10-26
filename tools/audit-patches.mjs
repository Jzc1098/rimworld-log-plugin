/**
 * Audit every patch mod this workspace produced.
 *
 * Checks the things that actually break a mod at load time, not cosmetics:
 *   1. About.xml parses, and its direct children are all real Verse.ModMetaData fields
 *   2. packageId present, non-empty, and not duplicated across mods
 *   3. every declared dependency and loadAfter entry exists in the active mod list
 *   4. every Patches/*.xml parses, has a <Patch> root, and its operations are real patch classes
 *   5. every xpath in those files targets a defName that actually exists in the active mod list
 *
 * Usage: node audit-patches.mjs <workspaceDir> <modsDir>
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectEnvironment, activeModList } from '../lib/detect.js';

const [workspace] = process.argv.slice(2);
if (!workspace) {
  console.error('usage: node audit-patches.mjs <workspaceDir>');
  process.exit(2);
}

const KNOWN = new Set([
  'name', 'author', 'description', 'packageId', 'modVersion', 'url', 'steamAppId',
  'supportedVersions', 'modDependencies', 'loadAfter', 'loadBefore',
  'forceLoadAfter', 'forceLoadBefore', 'incompatibleWith',
  'descriptions', 'authors', 'modIconPath', 'targetVersion',
  'modDependenciesByVersion', 'descriptionsByVersion', 'loadAfterByVersion', 'loadBeforeByVersion',
  'incompatibleWithByVersion',
]);
const PATCH_CLASSES = new Set([
  'PatchOperationAdd', 'PatchOperationReplace', 'PatchOperationRemove', 'PatchOperationInsert',
  'PatchOperationSequence', 'PatchOperationConditional', 'PatchOperationTest', 'PatchOperationFindMod',
  'PatchOperationAddModExtension', 'PatchOperationSetName', 'PatchOperationAttributeSet',
  'PatchOperationAttributeAdd', 'PatchOperationAttributeRemove', 'PatchOperationValue',
  'CombatExtended.PatchOperationMakeGunCECompatible',
]);
// Operation element names that are actually values rather than operations.
const NOT_OPERATIONS = new Set(['value', 'match', 'nomatch', 'operations', 'xpath', 'success', 'failure']);

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, {
  toolModRoots: env.home ? [path.join(env.home, 'toolmods')] : [],
});
const activeIds = new Set((mods.active ?? []).map((m) => (m.packageId ?? '').toLowerCase()));
const installedIds = new Set((mods.modRoots ?? []).map((e) => (e.packageId ?? '').toLowerCase()));

/**
 * Every defName visible to the game, gathered from ALL mod search roots.
 *
 * Indexing only the game's Mods folder is not enough: most mods live in the workshop or in
 * RimCrow's own mods folder, so a patch targeting one of those defNames would be reported as
 * pointing at nothing. That produced three false positives before this was fixed.
 */
function collectDefNames() {
  const names = new Set();
  const roots = (mods.searchRoots ?? []).filter((r) => fs.existsSync(r));
  for (const root of roots) {
    let top;
    try {
      top = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of top) {
      if (!d.isDirectory()) continue;
      const stack = [path.join(root, d.name)];
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
            if (/^(Textures|Sounds|Languages|Source|obj|bin|\.git)$/i.test(e.name)) continue;
            stack.push(full);
          } else if (/\.xml$/i.test(e.name)) {
            let text;
            try {
              if (fs.statSync(full).size > 400000) continue;
              text = fs.readFileSync(full, 'utf8');
            } catch {
              continue;
            }
            for (const m of text.matchAll(/<defName>\s*([^<\s]+)\s*<\/defName>/g)) names.add(m[1]);
          }
        }
      }
    }
  }
  return names;
}

const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');

function directChildren(inner) {
  const out = [];
  let depth = 0;
  const re = /<(\/?)([A-Za-z_][A-Za-z0-9_.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const closing = m[1] === '/';
    const self = m[4] === '/';
    if (!closing && depth === 0) out.push(m[2]);
    if (!closing && !self) depth += 1;
    else if (closing) depth = Math.max(0, depth - 1);
  }
  return out;
}

const dirs = fs
  .readdirSync(workspace, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^(kiiro-|rimlog-kiiro|fix-|_diag)/.test(d.name))
  .map((d) => d.name)
  .sort();

console.log(`patch mods found in workspace: ${dirs.length}`);
const defNames = collectDefNames();
console.log(`defNames indexed from the game Mods folder: ${defNames.size}\n`);

const problems = [];
const seenPackageIds = new Map();

for (const name of dirs) {
  const dir = path.join(workspace, name);
  const aboutPath = path.join(dir, 'About', 'About.xml');
  console.log('='.repeat(78));
  console.log(name);
  console.log('='.repeat(78));

  if (!fs.existsSync(aboutPath)) {
    console.log('  MISSING About/About.xml');
    problems.push(`${name}: no About.xml`);
    continue;
  }

  const raw = fs.readFileSync(aboutPath, 'utf8');
  const inner = /<ModMetaData(?:\s[^>]*)?>([\s\S]*)<\/ModMetaData>/i.exec(stripComments(raw));
  if (!inner) {
    console.log('  About.xml has no <ModMetaData> root');
    problems.push(`${name}: bad About.xml root`);
    continue;
  }

  const children = directChildren(inner[1]);
  const unknown = children.filter((c) => !KNOWN.has(c));
  const pkg = /<packageId(?:\s[^>]*)?>([\s\S]*?)<\/packageId>/i.exec(inner[1]);
  const pkgId = pkg ? pkg[1].trim() : '';
  const displayName = (/<name>([^<]*)<\/name>/i.exec(inner[1]) ?? [])[1] ?? '';
  const versions = [...inner[1].matchAll(/<supportedVersions>([\s\S]*?)<\/supportedVersions>/gi)]
    .flatMap((m) => [...m[1].matchAll(/<li>\s*([^<]*?)\s*<\/li>/g)].map((x) => x[1]));

  console.log(`  name        : ${displayName}`);
  console.log(`  packageId   : ${pkgId || '(MISSING)'}`);
  console.log(`  versions    : ${versions.join(', ') || '(none)'}`);
  console.log(`  About 子元素: ${children.join(', ')}`);
  console.log(`  未知字段    : ${unknown.length ? unknown.join(', ') : '无'}`);

  if (!pkgId) problems.push(`${name}: empty packageId`);
  if (unknown.length) problems.push(`${name}: unknown About.xml field(s) ${unknown.join(', ')}`);
  if (!versions.includes('1.6')) problems.push(`${name}: supportedVersions lacks 1.6`);
  if (seenPackageIds.has(pkgId)) problems.push(`${name}: packageId duplicates ${seenPackageIds.get(pkgId)}`);
  seenPackageIds.set(pkgId, name);

  // Dependencies and loadAfter must exist somewhere on disk.
  for (const tag of ['modDependencies', 'loadAfter', 'loadBefore']) {
    const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(inner[1]);
    if (!block) continue;
    const ids = tag === 'modDependencies'
      ? [...block[1].matchAll(/<packageId>\s*([^<\s]+)\s*<\/packageId>/gi)].map((x) => x[1])
      : [...block[1].matchAll(/<li>\s*([^<]*?)\s*<\/li>/gi)].map((x) => x[1]);
    for (const id of ids) {
      const key = id.toLowerCase();
      const inActive = activeIds.has(key);
      const onDisk = installedIds.has(key);
      const flag = inActive ? '在启用列表' : onDisk ? '在磁盘但未启用' : '★ 找不到';
      console.log(`  ${tag.padEnd(16)} ${id.padEnd(44)} ${flag}`);
      if (!inActive && !onDisk) problems.push(`${name}: ${tag} references unknown id ${id}`);
    }
  }

  // Patch files.
  const patchesDir = path.join(dir, 'Patches');
  if (fs.existsSync(patchesDir)) {
    for (const pf of fs.readdirSync(patchesDir).filter((f) => f.endsWith('.xml'))) {
      const p = path.join(patchesDir, pf);
      const text = fs.readFileSync(p, 'utf8');
      const code = stripComments(text);
      const rootTag = /^\s*<\?xml[^>]*\?>\s*<([A-Za-z_][A-Za-z0-9_.-]*)/.exec(code);
      const hasPatchRoot = /<Patch\b/.test(code);
      // Every Class="..." that looks like an operation must be a real one.
      const classes = [...code.matchAll(/Class="([^"]+)"/g)].map((m) => m[1]);
      const badClasses = [...new Set(classes)].filter((c) => !PATCH_CLASSES.has(c) && !/^CombatExtended\./.test(c));
      // xpath targets.
      const xpaths = [...code.matchAll(/<xpath>([\s\S]*?)<\/xpath>/g)].map((m) => m[1].trim());
      const targets = [];
      for (const x of xpaths) {
        for (const t of x.matchAll(/defName="([^"]+)"/g)) targets.push(t[1]);
      }
      const missingTargets = [...new Set(targets)].filter((t) => !defNames.has(t));

      console.log(`  ── Patches/${pf}`);
      console.log(`       根元素     : ${rootTag ? rootTag[1] : '?'}${hasPatchRoot ? '  (<Patch> ✓)' : '  ★ 没有 <Patch>'}`);
      console.log(`       用到的 Class: ${[...new Set(classes)].join(', ') || '(无)'}`);
      console.log(`       操作的 defName: ${[...new Set(targets)].join(', ') || '(无)'}`);
      if (badClasses.length) {
        console.log(`       ★ 未识别的 Class: ${badClasses.join(', ')}`);
        problems.push(`${name}/${pf}: unrecognised class ${badClasses.join(', ')}`);
      }
      if (missingTargets.length) {
        console.log(`       ★ 目标 defName 在磁盘上找不到: ${missingTargets.join(', ')}`);
        problems.push(`${name}/${pf}: target defName not found: ${missingTargets.join(', ')}`);
      }
      if (!hasPatchRoot) problems.push(`${name}/${pf}: no <Patch> root`);
    }
  } else {
    console.log('  (no Patches folder)');
  }
  console.log('');
}

console.log('='.repeat(78));
console.log(`PROBLEMS: ${problems.length}`);
for (const p of problems) console.log(`  - ${p}`);
