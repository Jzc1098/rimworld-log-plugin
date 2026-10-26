// Audit weapon and armour definitions for Combat Extended coverage.
//
// Why this exists: the two failure modes this finds are both silent at load time and only surface
// later, as a stat panel reading 0 or as a deflection warning during combat. CE's own checks run at
// use time --
//   StatWorker_MeleeDamageAverage errors when any tool is not a ToolCE, and
//   ArmorUtilityCE.GetDeflectDamageInfo falls back to a hard-coded 50 penetration when it cannot find
//   a penetration value at all.
// -- so a weapon can be broken for hours of play without a single startup message.
//
// ## What it cannot see
//
// It reads mod files on disk, so it reports the state BEFORE any patch mod is applied. A weapon that
// ships unconverted in its own mod but is converted by a patch mod (this workspace has several) is
// still listed. That is not so much a false positive as a different question being answered: this
// tells you which mods ship no CE data of their own, which is where to look first.
//
// Reading the post-patch state would mean reimplementing RimWorld's patch pipeline. The cheap
// cross-check is the game log, where an unconverted melee weapon announces itself with
//   Trying to get stat MeleeDamageAverage from X which has no support for Combat Extended.
//
// It reports observations, not verdicts. Whether a given weapon *should* be CE-converted is a design
// question (a custom verb may carry mechanics that conversion would break), so nothing here is
// labelled "wrong".
//
// Usage:
//   node ce-audit.mjs                      audit every enabled mod
//   node ce-audit.mjs <packageId> [...]    audit only these mods
//   node ce-audit.mjs --mods               list enabled mods with CE-related counts, no detail

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => pathToFileURL(path.join(pluginRoot, 'lib', name)).href;
const detect = await import(lib('detect.js'));

const args = process.argv.slice(2);
const listOnly = args.includes('--mods');
const wanted = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());

const env = detect.detectEnvironment();
const modlist = detect.activeModList(env.profile, env.config, {
  toolModRoots: [path.join(env.home ?? '', 'toolmods')],
});
const active = modlist.active ?? [];

// Only enabled mods are audited: a disabled mod's weapons cannot appear in play.
// Core and the DLCs are excluded because CE converts them itself (Patches/Core, Patches/Royalty, ...).
// Including them drowned every run in ~165 hits that are CE's job, not the reader's.
const targets = wanted.length
  ? active.filter((m) => wanted.includes(String(m.packageId ?? '').toLowerCase()))
  : active.filter((m) => !/^ludeon\.rimworld/i.test(String(m.packageId ?? '')));

/** Collect every XML file under a mod directory, skipping assets and build output. */
function xmlFiles(dir) {
  const out = [];
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
        if (/^(Textures|Sounds|\.git|obj|Source|Assemblies|Languages)$/i.test(e.name)) continue;
        stack.push(full);
        continue;
      }
      if (/\.xml$/i.test(e.name)) out.push(full);
    }
  }
  return out;
}

/**
 * Count the direct `<li>` children of the first `<tools>` element in a block, and how many of them
 * carry Class="CombatExtended.ToolCE".
 *
 * Counting with a regex over the raw slice does not work, and both ways of doing it were tried and
 * both miscounted on real files:
 *   - `/<li\b/g` also counts the `<li>` entries inside each tool's `<capacities>`;
 *   - `/^\s*<li\b/gm` misses self-contained ones, because some mods write `<li>Cut</li>` on one line
 *     while others put it on three.
 * So walk the tags and track depth instead. Purely lexical: no XML parser, no dependency.
 *
 * @param block - the `<ThingDef>` text.
 * @returns `{ tools, ceTools }`.
 */
function countTools(block) {
  const start = block.indexOf('<tools>');
  if (start < 0) return { tools: 0, ceTools: 0 };
  const end = block.indexOf('</tools>', start);
  const slice = block.slice(start + '<tools>'.length, end < 0 ? block.length : end);

  let depth = 0;
  let tools = 0;
  let ceTools = 0;
  let i = 0;
  while (i < slice.length) {
    const lt = slice.indexOf('<', i);
    if (lt < 0) break;

    // Comments must be consumed whole: mod files here are heavily commented, and comment text
    // contains angle brackets and `<li>` examples that would otherwise shift the depth.
    if (slice.startsWith('<!--', lt)) {
      const close = slice.indexOf('-->', lt + 4);
      i = close < 0 ? slice.length : close + 3;
      continue;
    }

    const gt = slice.indexOf('>', lt);
    if (gt < 0) break;
    const raw = slice.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      depth--;
      continue;
    }
    const name = (/^([A-Za-z_][\w.\-]*)/.exec(raw) ?? [])[1];
    if (!name) continue; // declaration, CDATA or similar; nothing to track
    const selfClosing = raw.endsWith('/');

    if (name === 'li' && depth === 0) {
      tools++;
      if (/Class\s*=\s*"CombatExtended\.ToolCE"/.test(raw)) ceTools++;
    }
    if (!selfClosing) depth++;
  }
  return { tools, ceTools };
}

/** Pull `<ThingDef ...> ... <defName>X</defName> ... </ThingDef>` blocks out of a file's text. */
function thingBlocks(text) {
  const blocks = [];
  const re = /<ThingDef\b[^>]*>([\s\S]*?)<\/ThingDef>/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[0]);
  return blocks;
}

const tally = [];
let scannedMods = 0;
let scannedFiles = 0;

for (const mod of targets) {
  const dir = mod.dir;
  if (!dir || !fs.existsSync(dir)) continue;
  scannedMods++;
  const findings = [];

  for (const file of xmlFiles(dir)) {
    scannedFiles++;
    let text;
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Cheap pre-filter: most files are defs but not weapons.
    if (!/<ThingDef\b/.test(text)) continue;

    for (const block of thingBlocks(text)) {
      const defName = (/<defName>([^<]+)<\/defName>/.exec(block) ?? [])[1];
      if (!defName) continue;
      const rel = path.relative(dir, file);

      const isRanged = /<verbs>/.test(block) || /<defaultProjectile>/.test(block);
      const isMelee = /<tools>/.test(block);

      // 1. Melee tools that CE will refuse to score.
      if (isMelee) {
        const { tools: topLevel, ceTools } = countTools(block);
        if (topLevel > 0 && ceTools < topLevel) {
          findings.push({
            kind: 'tools-not-ce',
            defName,
            file: rel,
            detail: `${ceTools} / ${topLevel} 个 tool 是 ToolCE`,
            effect: 'MeleeDamageAverage 会返回 0 并报错（面板显示 0；实战伤害走 verb，不受影响）',
          });
        }
      }

      // 2. Ranged weapons whose projectile is not a CE projectile.
      const proj = (/<defaultProjectile>([^<]+)<\/defaultProjectile>/.exec(block) ?? [])[1];
      if (proj) {
        findings.push({
          kind: 'ranged-maybe-unconverted',
          defName,
          file: rel,
          detail: `defaultProjectile = ${proj}`,
          effect: '若该弹丸的 <projectile> 不是 CombatExtended.ProjectilePropertiesCE，'
            + '则整条弹道不走 CE，护甲穿透会落到 CE 的兜底值',
          needsFollowUp: proj,
        });
      }
    }
  }

  if (findings.length) tally.push({ mod, findings });
}

if (listOnly) {
  console.log('启用模组: ' + active.length + '   已扫描: ' + scannedMods + '   文件: ' + scannedFiles);
  console.log('');
  for (const { mod, findings } of tally) {
    const tools = findings.filter((f) => f.kind === 'tools-not-ce').length;
    const ranged = findings.filter((f) => f.kind === 'ranged-maybe-unconverted').length;
    console.log('  ' + String(mod.packageId ?? mod.name).padEnd(42)
      + ' tools未CE=' + String(tools).padStart(3)
      + '  远程待查=' + String(ranged).padStart(3));
  }
} else {
  console.log('启用模组: ' + active.length + '   已扫描: ' + scannedMods + '   文件: ' + scannedFiles);
  console.log('有发现的 mod: ' + tally.length);
  console.log('');
  for (const { mod, findings } of tally) {
    console.log('=== ' + (mod.name ?? '') + '  [' + (mod.packageId ?? '') + ']');
    console.log('    ' + mod.dir);
    for (const f of findings) {
      console.log('    · ' + f.defName + '   (' + f.kind + ')');
      console.log('        ' + f.detail);
      console.log('        影响: ' + f.effect);
      console.log('        文件: ' + f.file);
    }
    console.log('');
  }
}
