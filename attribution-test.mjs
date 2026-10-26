/**
 * Isolation test for mod attribution.
 *
 * Reproduces the real failure that this plugin got wrong on live data: a stack trace whose build
 * folder is `GraphicsSetter`, belonging to an *enabled* mod named `Graphics Settings+` with
 * packageId `Telefonmast.GraphicsSettings` and a folder named by workshop id. No name-based
 * comparison links those, but the shipped `GraphicSetter.dll` does.
 *
 * Usage: node attribution-test.mjs
 */

// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区里写记录。
// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区写记录。
// 测试不该产生副作用，这里直接关掉。
process.env.RIMLOG_AUTO_ARCHIVE = '0';

import assert from 'node:assert/strict';

import { clusterProblems, modKeys, normalizeModKey } from './lib/parse.js';

const problems = [];
const notes = [];
function check(label, fn) {
  try {
    const value = fn();
    notes.push(`  ok   ${label}${value === undefined ? '' : ` -> ${value}`}`);
    return value;
  } catch (error) {
    problems.push(`  FAIL ${label}: ${error?.message ?? error}`);
    return undefined;
  }
}

console.log('== attribution isolation tests ==');

// --- the synthetic environment -------------------------------------------
const GRAPHICS_FRAME = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld\\Mods\\GraphicsSetter\\Source\\GraphicSetter\\GraphicSetter\\Patches\\TextureLoadingPatch.cs';

const modRoots = [
  { root: 'C:\\Games\\RimWorld\\Mods\\1678847247', packageId: 'Telefonmast.GraphicsSettings', name: 'Graphics Settings+' },
  { root: 'C:\\Games\\RimCrow\\mods\\3652938473', packageId: 'taranchuk.fastergameloading', name: 'Faster Game Loading - Continued' },
];
const activeMods = [
  { packageId: 'telefonmast.graphicssettings', name: 'Graphics Settings+', dir: 'C:\\Games\\RimWorld\\Mods\\1678847247', installed: true },
  { packageId: 'taranchuk.fastergameloading', name: 'Faster Game Loading - Continued', dir: 'C:\\Games\\RimCrow\\mods\\3652938473', installed: true },
];
// Keys exactly as detect.js builds them.
const byAssembly = new Map([
  [normalizeModKey('GraphicSetter'), { dir: 'C:\\Games\\RimWorld\\Mods\\1678847247', packageId: 'Telefonmast.GraphicsSettings', name: 'Graphics Settings+' }],
  [normalizeModKey('FasterGameLoading'), { dir: 'C:\\Games\\RimCrow\\mods\\3652938473', packageId: 'taranchuk.fastergameloading', name: 'Faster Game Loading - Continued' }],
]);
const byFolder = new Map([
  ['1678847247', { dir: 'C:\\Games\\RimWorld\\Mods\\1678847247', packageId: 'Telefonmast.GraphicsSettings', name: 'Graphics Settings+' }],
  ['3652938473', { dir: 'C:\\Games\\RimCrow\\mods\\3652938473', packageId: 'taranchuk.fastergameloading', name: 'Faster Game Loading - Continued' }],
]);
const indexes = { byAssembly, byFolder };

/** The texture cluster as it appears in the real log. */
function textureEntry() {
  return [{
    time: '2026-10-08 16:35:29.413',
    level: 'ERROR',
    message: "Texture '' has dimensions (513 x 513) which are not multiples of 4. Compress will not work.",
    details: '',
    count: 147,
    relatedModIds: [],
    relatedFiles: [],
    inferredType: '',
    frames: [
      // Downstream loader — the mod that merely drove the load.
      { method: 'FasterGameLoading.EarlyModContentLoader.Update (FasterGameLoading.DelayedActions delayedActions)', file: '<b60736c24e0b4be3bcf38fa431a45044>' },
      { method: 'Verse.ModContentPack.ReloadContentInt_Patch3 (Verse.ModContentPack , System.Boolean )', file: '<e53399289d9b419d83f9f5b02c5cf609>' },
      { method: 'Verse.ModContentLoader`1[T].LoadItem (RimWorld.IO.VirtualFile file)', file: '<239ae808e7f5427aa8022d09e89ee1ed>' },
      // Upstream: the mod whose own patch raised the error.
      { method: 'GraphicSetter.Patches.TextureLoadingPatch+LoadTexture_Patch.Prefix (RimWorld.IO.VirtualFile file, UnityEngine.Texture2D& __result)', file: GRAPHICS_FRAME },
      { method: 'GraphicSetter.Patches.TextureLoadingPatch+LoadTexture_Patch.CustomLoad (RimWorld.IO.VirtualFile file, System.Boolean readable)', file: GRAPHICS_FRAME },
    ],
    format: 'realtime',
  }];
}

// --- key hygiene --------------------------------------------------------
check('modKeys produces every useful spelling', () => {
  assert.deepEqual(modKeys('Graphics Settings+'), { loose: 'graphicssettings', lean: 'graphicssettings', tight: 'graphicsetings' });
  assert.deepEqual(modKeys('Telefonmast.GraphicsSettings'), { loose: 'telefonmastgraphicssettings', lean: 'telefonmastgraphicssettings', tight: 'telefonmastgraphicsetings' });
  // A workshop id keeps its digits in `loose` and has nothing left in the letters-only forms.
  assert.deepEqual(modKeys('1678847247'), { loose: '1678847247', lean: '', tight: '' });
  return 'ok';
});

check('normalizeModKey collapses the doubled-letter difference', () => {
  // The real bug: lowercasing `GraphicsSetter` keeps a double s that `GraphicSetter` lacks.
  assert.notEqual('GraphicsSetter'.toLowerCase(), 'GraphicSetter'.toLowerCase());
  assert.equal(normalizeModKey('GraphicsSetter'), normalizeModKey('GraphicSetter'));
  return `${normalizeModKey('GraphicsSetter')}`;
});

// --- the real case ------------------------------------------------------
check('attributes the texture cluster to the mod that ships GraphicSetter.dll', () => {
  const clusters = clusterProblems(textureEntry(), modRoots, activeMods, indexes);
  assert.equal(clusters.length, 1);
  const mod = clusters[0].mod;
  assert.ok(mod, 'no attribution produced');
  assert.equal(mod.packageId, 'Telefonmast.GraphicsSettings', `wrong mod: ${JSON.stringify(mod)}`);
  assert.equal(mod.enabled, true, 'the mod is enabled and must be reported as such');
  assert.equal(mod.confidence, 'medium');
  return `${mod.name} [${mod.packageId}] enabled=${mod.enabled}`;
});

check('does not flag the installed mod as a stray', () => {
  const clusters = clusterProblems(textureEntry(), modRoots, activeMods, indexes);
  assert.deepEqual(clusters[0].strayMods, [], `strayMods=${JSON.stringify(clusters[0].strayMods)}`);
  return 'no stray warning';
});

check('the downstream loader does not win over the upstream culprit', () => {
  const clusters = clusterProblems(textureEntry(), modRoots, activeMods, indexes);
  assert.notEqual(clusters[0].mod.packageId, 'taranchuk.fastergameloading');
  return `resolved to ${clusters[0].mod.name}`;
});

// --- without the disk index, the old behaviour is the fallback ----------
check('without a disk index it says so instead of inventing a match', () => {
  const clusters = clusterProblems(textureEntry(), modRoots, activeMods, {});
  const mod = clusters[0].mod;
  // Nothing links `GraphicsSetter` to the mod by name, so the honest answer is "not determined".
  assert.notEqual(mod?.packageId, 'Telefonmast.GraphicsSettings', 'claimed a match it cannot support');
  return `fallback: ${mod ? `${mod.name} (${mod.confidence})` : 'undefined'}`;
});

check('a genuinely absent mod is still reported as a stray', () => {
  const entries = textureEntry();
  entries[0].frames = [{
    method: 'GhostMod.Patches.Something.Prefix ()',
    // A hand-built checkout layout: the folder before `Source` is the mod, not the checkout.
    file: 'D:\\SomeoneElse\\CodeLibrary\\rimworld-dev\\GhostMod\\Source\\Patches\\Something.cs',
  }];
  const clusters = clusterProblems(entries, modRoots, activeMods, indexes);
  assert.deepEqual(clusters[0].strayMods, ['GhostMod'], `strayMods=${JSON.stringify(clusters[0].strayMods)}`);
  return 'GhostMod flagged';
});

check('workshop-id folders resolve through byFolder', () => {
  const entries = textureEntry();
  entries[0].frames = [{
    method: 'Something.Happens ()',
    file: 'C:\\Games\\RimWorld\\Mods\\1678847247\\Source\\Some.cs',
  }];
  const clusters = clusterProblems(entries, modRoots, activeMods, indexes);
  assert.equal(clusters[0].mod.packageId, 'Telefonmast.GraphicsSettings');
  return 'resolved by folder id';
});

console.log('\n== results ==');
for (const line of notes) console.log(line);
if (problems.length > 0) {
  console.log('\n== problems ==');
  for (const line of problems) console.log(line);
  process.exit(1);
}
console.log('\nAttribution resolves the real GraphicsSetter case.');
