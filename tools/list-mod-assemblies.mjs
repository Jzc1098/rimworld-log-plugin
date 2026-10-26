// List the assemblies a mod directory ships, checking the 1.6 / 1.5 / root layouts.
//
// Written after two recursive whole-disk scans timed out: scanning 1600 workshop directories for XML
// content is far too slow. Reading one directory's Assemblies folder per mod is bounded and enough to
// answer "which mod ships this code".
//
// Usage: node list-mod-assemblies.mjs <modId> [<modId> ...]

import fs from 'node:fs';
import path from 'node:path';

// 搜索根由环境变量给出（公开版不写死本机路径）：
//   WORKSHOP_DIR / RIMCROW_HOME / RIMWORLD_DIR（见 README 的环境变量一节）
const roots = [
  process.env.WORKSHOP_DIR,
  process.env.RIMCROW_HOME ? path.join(process.env.RIMCROW_HOME, 'mods') : undefined,
  process.env.RIMWORLD_DIR ? path.join(process.env.RIMWORLD_DIR, 'Mods') : undefined,
  process.env.RIMCROW_HOME ? path.join(process.env.RIMCROW_HOME, 'tools', 'steamcmd', 'steamapps', 'workshop', 'content', '294100') : undefined,
].filter(Boolean);
if (roots.length === 0) {
  console.error('请至少设置 WORKSHOP_DIR 或 RIMCROW_HOME 或 RIMWORLD_DIR 之一');
  process.exit(2);
}

/** Find the directory for a workshop id, preferring whichever root actually has it. */
function locate(id) {
  for (const root of roots) {
    const direct = path.join(root, id);
    if (fs.existsSync(direct)) return direct;
  }
  return undefined;
}

function about(dir) {
  for (const c of ['About/About.xml', '1.6/About/About.xml']) {
    const p = path.join(dir, ...c.split('/'));
    if (!fs.existsSync(p)) continue;
    try {
      const t = fs.readFileSync(p, 'utf8');
      return {
        pkg: (/<packageId[^>]*>([^<]*)<\/packageId>/i.exec(t) ?? [])[1] ?? '',
        name: (/<name>([^<]*)<\/name>/i.exec(t) ?? [])[1] ?? '',
      };
    } catch { /* keep looking */ }
  }
  return { pkg: '', name: '' };
}

function dlls(dir) {
  const out = [];
  for (const sub of ['1.6/Assemblies', '1.5/Assemblies', 'Assemblies', '1.6', '1.5']) {
    const d = path.join(dir, ...sub.split('/'));
    if (!fs.existsSync(d)) continue;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && /\.dll$/i.test(e.name)) out.push(sub + '/' + e.name);
    }
  }
  return [...new Set(out)];
}

/** Directories whose name hints they are content folders rather than version folders. */
function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^(About|Assemblies|Defs|Patches|Languages|Textures|Sounds|Source|\.git|obj)$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

for (const id of process.argv.slice(2)) {
  const dir = locate(id);
  if (!dir) {
    console.log(id + '  -> not found in any root');
    continue;
  }
  const a = about(dir);
  console.log(id + '  ' + (a.pkg || '(no packageId)') + '  ::  ' + a.name);
  console.log('   dir  : ' + dir);
  const list = dlls(dir);
  if (list.length) {
    for (const d of list) console.log('   dll  : ' + d);
  } else {
    console.log('   dll  : (none at 1.6/1.5/root Assemblies)');
    const subs = subdirs(dir);
    if (subs.length) console.log('   sub  : ' + subs.join(', '));
  }
  console.log('');
}
